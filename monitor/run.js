#!/usr/bin/env node
// Monitor de aluguéis: roda os coletores de um grupo, filtra/deduplica, compara com o estado
// (monitor/state/vistos.json) e avisa no Telegram os anúncios NOVOS e as BAIXAS DE PREÇO.
//
//   node monitor/run.js --grupo=ssjb|df|todos [--dry-run] [--seed] [--coletores=olx,dfimoveis] [--cron]
//
//   --seed     marca tudo como visto sem notificar; manda só 1 mensagem de resumo
//   --dry-run  não chama o Telegram (imprime as mensagens no console)
//   --coletores=a,b  roda só estes coletores (alias antigo: --so=)
//   --cron     imprime linhas sugeridas para o crontab e sai
const fs = require('fs');
const path = require('path');
const config = require('./config');
const common = require('../scrapers/common');
common.FILTRO.precoMax = config.PRECO_MAX; // passaFiltro passa a usar o PRECO_MAX do .env
const { executar } = require('./coletores');
const { normalizar, chavesDe, chaveFuzzy } = require('./normalizar');
const geo = require('./geo');
const telegram = require('./telegram');
const msg = require('./mensagens');

const STATE = config.STATE_DIR;
const VISTOS = path.join(STATE, 'vistos.json');
const EXEC_LOG = path.join(STATE, 'execucoes.jsonl');
const LOCK = path.join(STATE, 'run.lock');

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const ts = () => new Date().toISOString();
// Datas no estado são só o dia (fuso de Brasília): o vistos.json é commitado a cada execução no
// GitHub Actions e não deve mudar a cada rodada sem necessidade.
const hoje = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const MAX_LINHAS_LOG = 300;
const log = (...m) => console.log(`[monitor ${ts().slice(11, 19)}]`, ...m);

// ---------------------------------------------------------------- lock
function adquirirLock() {
  fs.mkdirSync(STATE, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(LOCK, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, inicio: ts(), grupo: args.grupo }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let info = {};
      try { info = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch {}
      let vivo = false;
      try { process.kill(info.pid, 0); vivo = true; } catch (err) { vivo = err.code === 'EPERM'; }
      const idadeMin = info.inicio ? (Date.now() - Date.parse(info.inicio)) / 60000 : Infinity;
      if (vivo && idadeMin < config.LOCK_MAX_MIN) {
        log(`outra instância em execução (pid ${info.pid}, grupo ${info.grupo}, há ${Math.round(idadeMin)} min) — saindo`);
        return false;
      }
      if (vivo) { log(`lock com ${Math.round(idadeMin)} min (pid ${info.pid}) — considerado travado, matando`); try { process.kill(info.pid, 'SIGKILL'); } catch {} }
      else log('lock órfão removido');
      fs.rmSync(LOCK, { force: true });
    }
  }
  return false;
}
function liberarLock() {
  try { const info = JSON.parse(fs.readFileSync(LOCK, 'utf8')); if (info.pid === process.pid) fs.rmSync(LOCK, { force: true }); } catch {}
}

// ---------------------------------------------------------------- estado
const soData = (v) => (typeof v === 'string' ? v.slice(0, 10) : v);
function carregarEstado() {
  let e;
  try { e = JSON.parse(fs.readFileSync(VISTOS, 'utf8')); } catch { e = {}; }
  e = { versao: 2, itens: {}, coletores: {}, ...e, versao: 2 };
  // migração: timestamps -> data; campos voláteis dos coletores vão só para o execucoes.jsonl
  for (const it of Object.values(e.itens)) {
    it.primeiro_visto = soData(it.primeiro_visto); it.ultimo_visto = soData(it.ultimo_visto);
    for (const b of it.baixas || []) b.em = soData(b.em);
  }
  for (const [n, c] of Object.entries(e.coletores)) {
    e.coletores[n] = { primeiro_sucesso: soData(c.primeiro_sucesso) || null, ultimo_sucesso: soData(c.ultimo_sucesso) || null };
  }
  return e;
}
// JSON com chaves de objetos ordenadas (arrays mantêm a ordem) => diff mínimo entre commits.
function ordenado(v) {
  if (Array.isArray(v)) return v.map(ordenado);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, ordenado(v[k])]));
  return v;
}
function salvarEstado(e) {
  const tmp = VISTOS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ordenado(e), null, 1) + '\n');
  fs.renameSync(tmp, VISTOS);
}
// Acrescenta uma linha ao execucoes.jsonl mantendo só as últimas MAX_LINHAS_LOG.
function logExecucao(obj) {
  fs.mkdirSync(STATE, { recursive: true });
  let linhas = [];
  try { linhas = fs.readFileSync(EXEC_LOG, 'utf8').split('\n').filter(Boolean); } catch {}
  linhas.push(JSON.stringify(obj));
  const tmp = EXEC_LOG + '.tmp';
  fs.writeFileSync(tmp, linhas.slice(-MAX_LINHAS_LOG).join('\n') + '\n');
  fs.renameSync(tmp, EXEC_LOG);
}
function indexar(estado) {
  const idx = new Map(); const fz = new Map();
  for (const [id, it] of Object.entries(estado.itens)) {
    for (const k of it.chaves || []) idx.set(k, id);
    if (it.fuzzy) fz.set(it.fuzzy, id);
  }
  return { idx, fz };
}
function registrar(estado, a, agora, extra = {}) {
  const ks = chavesDe(a);
  const id = ks[0];
  estado.itens[id] = {
    chaves: ks, fuzzy: chaveFuzzy(a), primeiro_visto: agora, ultimo_visto: agora,
    preco: a.preco, preco_inicial: a.preco, site: a.site, regiao: a.regiao, bairro: a.bairro || null,
    area_m2: a.area_m2 ?? null, quartos: a.quartos ?? null, titulo: (a.titulo || '').slice(0, 120), link: a.link,
    data_publicacao: a.data_publicacao || null, ...extra,
  };
  return id;
}

// ---------------------------------------------------------------- principal
async function main() {
  if (args.cron) {
    const node = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].find((n) => fs.existsSync(n)) || process.execPath, dir = config.RAIZ;
    console.log(`# crontab -e  (logs em monitor/state/cron.log)`);
    console.log(`*/${config.FREQ_MIN.ssjb} * * * * cd ${dir} && ${node} monitor/run.js --grupo=ssjb >> monitor/state/cron.log 2>&1`);
    console.log(`17 */${Math.max(1, Math.round(config.FREQ_MIN.df / 60))} * * * cd ${dir} && ${node} monitor/run.js --grupo=df >> monitor/state/cron.log 2>&1`);
    return 0;
  }
  const grupo = args.grupo || 'ssjb';
  let nomes = config.GRUPOS[grupo];
  if (!nomes) { console.error(`grupo inválido: ${grupo} (use ssjb, df ou todos)`); return 2; }
  const soEstes = typeof args.coletores === 'string' ? args.coletores : typeof args.so === 'string' ? args.so : null;
  if (soEstes) {
    nomes = soEstes.split(',').map((s) => s.trim()).filter(Boolean);
    const invalidos = nomes.filter((n) => !config.COLETORES[n]);
    if (invalidos.length) { console.error(`coletor(es) inválido(s): ${invalidos.join(', ')} (válidos: ${Object.keys(config.COLETORES).join(', ')})`); return 2; }
  }
  const seed = !!args.seed;
  telegram.setDryRun(!!args['dry-run']);
  if (!adquirirLock()) {
    logExecucao({ inicio: ts(), grupo, pulado: 'lock ocupado' });
    return 0;
  }
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { liberarLock(); process.exit(130); });

  if (!config.TELEGRAM_TOKEN && !args['dry-run']) log('AVISO: TELEGRAM_TOKEN ausente (env/.env) — rodando em dry-run, mensagens só no console');
  const t0 = Date.now();
  const execucao = { inicio: ts(), grupo, coletores_pedidos: soEstes ? nomes : undefined, seed, dry_run: telegram.isDryRun(), preco_max: config.PRECO_MAX, coletores: {} };
  log(`grupo ${grupo}: ${nomes.join(', ')}${seed ? ' [seed]' : ''}${telegram.isDryRun() ? ' [dry-run]' : ''}`);

  // 0) anúncios já vistos → KNOWN_LINKS_FILE: os crawlers pulam a página de detalhe
  //    de quem já conhecem com o mesmo preço (economiza a maior parte do tempo do job)
  if (!seed) {
    const { normalizarLink } = require('../scrapers/known');
    const conhecidos = {};
    for (const it of Object.values(carregarEstado().itens || {})) {
      if (!it.link) continue;
      const { link, chaves, fuzzy, motivo, notificado, preco_inicial, primeiro_visto, ultimo_visto, baixas, ...campos } = it;
      conhecidos[normalizarLink(link)] = campos;
    }
    const arq = path.join(__dirname, 'state', 'work', 'known.json');
    fs.mkdirSync(path.dirname(arq), { recursive: true });
    fs.writeFileSync(arq, JSON.stringify(conhecidos));
    process.env.KNOWN_LINKS_FILE = arq;
    log(`${Object.keys(conhecidos).length} anúncios conhecidos (detalhe pulado se o preço não mudou)`);
  }

  // 1) coletores em sequência (um navegador por vez; VM de 1 GB)
  const brutos = [];
  const resultados = {};
  for (const nome of nomes) {
    log(`→ ${nome}...`);
    const r = await executar(nome, { log });
    resultados[nome] = r;
    brutos.push(...r.itens);
    execucao.coletores[nome] = { brutos: r.itens.length, seg: r.seg, pico_rss_mb: r.pico_rss_mb, erro: r.erro || undefined, trafego: r.trafego || undefined };
    log(`  ${nome}: ${r.itens.length} itens em ${r.seg}s, pico ${r.pico_rss_mb ?? '?'} MB${r.erro ? ' — ERRO: ' + r.erro : ''}`);
  }

  // 2) normaliza + filtra + dedupe
  const { lista, descartes } = normalizar(brutos, { regioesAlerta: config.REGIOES_ALERTA });
  for (const a of lista) for (const c of a._coletores) if (execucao.coletores[c]) execucao.coletores[c].aprovados = (execucao.coletores[c].aprovados || 0) + 1;
  execucao.brutos = brutos.length; execucao.aprovados = lista.length; execucao.descartes = descartes;
  log(`${brutos.length} brutos → ${lista.length} aprovados após filtro/dedupe`);

  // 3) compara com o estado
  const estado = carregarEstado();
  const agora = hoje();
  // coletor que nunca teve sucesso: sua primeira coleta vira "seed" (evita enxurrada de anúncios antigos)
  const coletorNovo = {};
  for (const nome of nomes) {
    const st = { primeiro_sucesso: null, ultimo_sucesso: null, ...estado.coletores[nome] };
    coletorNovo[nome] = !st.primeiro_sucesso;
    if (resultados[nome].itens.length) { st.ultimo_sucesso = agora; st.primeiro_sucesso ||= agora; }
    estado.coletores[nome] = st;
  }
  const { idx, fz } = indexar(estado);
  const eventos = []; const silenciosos = [];
  let jaVistos = 0;
  for (const a of lista) {
    const ks = chavesDe(a);
    const f = chaveFuzzy(a);
    let id = ks.map((k) => idx.get(k)).find((i) => i && estado.itens[i]);
    const porLink = !!id;
    if (!id && f) { const i = fz.get(f); if (i && estado.itens[i]) id = i; }
    if (id) {
      jaVistos++;
      const it = estado.itens[id];
      it.ultimo_visto = agora;
      it.chaves = [...new Set([...(it.chaves || []), ...ks])];
      for (const k of ks) idx.set(k, id);
      if (porLink && a.preco != null && it.preco != null && a.preco < it.preco && !seed) {
        eventos.push(Object.assign(a, { _evento: 'baixou', _preco_anterior: it.preco, _id: id }));
      } else if (a.preco != null) { it.preco = a.preco; it.fuzzy = f; }
      continue;
    }
    if (seed || a._coletores.every((c) => coletorNovo[c])) silenciosos.push(a);
    else eventos.push(Object.assign(a, { _evento: 'novo' }));
  }
  for (const a of silenciosos) { const id = registrar(estado, a, agora, { notificado: false, motivo: seed ? 'seed' : 'primeira coleta do site' }); for (const k of estado.itens[id].chaves) idx.set(k, id); }
  execucao.ja_vistos = jaVistos; execucao.silenciosos = silenciosos.length;
  execucao.novos = eventos.filter((e) => e._evento === 'novo').length;
  execucao.baixas = eventos.filter((e) => e._evento === 'baixou').length;
  log(`${jaVistos} já vistos, ${execucao.novos} novos, ${execucao.baixas} baixas de preço, ${silenciosos.length} registrados sem aviso`);

  // 4) geolocaliza (São Sebastião / Jardim Botânico) só o que vai ser notificado
  for (const a of eventos) if (a.regiao === 'São Sebastião' || a.regiao === 'Jardim Botânico') await geo.localizar(a);
  geo.salvarCache();

  // 5) notifica — só grava no estado o que foi enviado com sucesso (falha => tenta de novo na próxima)
  let notificados = 0; const errosEnvio = [];
  for (const m of msg.montar(eventos)) {
    try {
      await telegram.enviar(m.texto);
      for (const a of m.itens) {
        if (a._evento === 'baixou') { const it = estado.itens[a._id]; it.preco = a.preco; it.fuzzy = chaveFuzzy(a); it.baixas = [...(it.baixas || []), { em: agora, de: a._preco_anterior, para: a.preco }]; }
        else registrar(estado, a, agora, { notificado: true, dist_terminal_km: a.dist_terminal_km ?? null });
        notificados++;
      }
    } catch (e) { errosEnvio.push(e.message); log('falha ao enviar no Telegram:', e.message); }
  }
  // resumo do seed (1 mensagem)
  if (silenciosos.length && (seed || notificados === 0)) {
    const porReg = {};
    for (const a of silenciosos) porReg[a.regiao] = (porReg[a.regiao] || 0) + 1;
    const top = Object.entries(porReg).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([r, n]) => `${msg.esc(r)} ${n}`).join(' · ');
    const falhas = nomes.filter((n) => resultados[n].erro);
    const texto = seed
      ? `✅ <b>Monitor ativo</b> (${msg.esc(grupo)}): ${msg.plural(silenciosos.length, 'imóvel já existente', 'imóveis já existentes')} até ${msg.brl(config.PRECO_MAX)}, vou avisar só os novos.\n${top}` +
        (falhas.length ? `\n⚠️ sem resposta nesta rodada: ${msg.esc(falhas.join(', '))}` : '')
      : `ℹ️ Primeira coleta de ${msg.esc([...new Set(silenciosos.flatMap((a) => a._coletores))].join(', '))}: ${msg.plural(silenciosos.length, 'imóvel registrado', 'imóveis registrados')} sem aviso (já existiam).`;
    try { await telegram.enviar(texto, { previa: false }); } catch (e) { errosEnvio.push(e.message); }
  }

  // 6) limpeza e persistência
  const limite = Date.now() - config.ESQUECER_DIAS * 86400000;
  let esquecidos = 0;
  for (const [id, it] of Object.entries(estado.itens)) if (Date.parse(it.ultimo_visto) < limite) { delete estado.itens[id]; esquecidos++; }
  salvarEstado(estado);

  Object.assign(execucao, {
    notificados, erros_envio: errosEnvio.length ? errosEnvio : undefined, esquecidos: esquecidos || undefined,
    total_estado: Object.keys(estado.itens).length, fim: ts(), duracao_s: Math.round((Date.now() - t0) / 1000),
    pico_rss_mb: Math.max(0, ...Object.values(execucao.coletores).map((c) => c.pico_rss_mb || 0)) || null,
    rss_monitor_mb: Math.round(process.memoryUsage().rss / 1048576),
  });
  logExecucao(execucao);
  log(`fim: ${notificados} notificados em ${execucao.duracao_s}s (estado: ${execucao.total_estado} anúncios)`);
  return 0;
}

main().then((c) => { liberarLock(); process.exit(c); })
  .catch((e) => { console.error(e); liberarLock(); try { logExecucao({ inicio: ts(), grupo: args.grupo, erro_fatal: String(e && e.stack || e).slice(0, 2000) }); } catch {} process.exit(1); });
