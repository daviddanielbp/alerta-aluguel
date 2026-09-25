'use strict';
// Mede o tráfego de rede de cada coletor, SEM e COM bloqueio (monitor/instrument.js).
//
//   node monitor/medir_trafego.js                    # todos
//   node monitor/medir_trafego.js --only ss_jb_a,olx  # alguns
//   node monitor/medir_trafego.js --conc 2 --modes sem,com
//
// Cada coletor roda como processo filho:  node -r ./monitor/instrument_preload.js scrapers/x.js
// (INSTRUMENT_BLOCK=0|1). Duas medições por execução:
//   - "HTTP": bytes de headers+corpos contados pelo instrument (Playwright request.sizes() + undici);
//   - "fio":  bytes por processo (node + Chromium filhos) via `nettop` do macOS em modo delta,
//             que inclui TLS handshake, cabeçalhos TCP/IP, ACKs e QUIC.
// Os crawlers rodam numa cópia sandbox (MEDICAO_TMP); data/ e data_ss/ reais só recebem backup + verificação.
// Saídas/logs de cada execução em monitor/_runs/. --recalc só recalcula as estimativas do JSON.
// Resultado: monitor/medicao_trafego.json + tabela no stdout + estimativas mensais.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNS_DIR = path.join(__dirname, '_runs');
const OUT_JSON = path.join(__dirname, 'medicao_trafego.json');

const COLETORES = [
  { nome: 'ss_jb_a', script: 'scrapers/ss_jb_a.js', saida: 'data_ss/ss_jb_a.json', grupo: 'SSJB', sites: ['olx', 'dfimoveis', 'imovelweb'] },
  { nome: 'ss_jb_b', script: 'scrapers/ss_jb_b.js', saida: 'data_ss/ss_jb_b.json', grupo: 'SSJB', sites: ['zap', 'chaves', 'quintoandar', 'loft', 'lugarcerto', 'casamineira'] },
  { nome: 'olx', script: 'scrapers/olx.js', saida: 'data/olx.json', grupo: 'DF', sites: ['olx'] },
  { nome: 'dfimoveis', script: 'scrapers/dfimoveis.js', saida: 'data/dfimoveis.json', grupo: 'DF', sites: ['dfimoveis'] },
  { nome: 'imovelweb', script: 'scrapers/imovelweb.js', saida: 'data/imovelweb.json', grupo: 'DF', sites: ['imovelweb'] },
  { nome: 'zap_vivareal', script: 'scrapers/zap_vivareal.js', saida: 'data/zap_vivareal.json', grupo: 'DF', sites: ['zap'] },
  { nome: 'quintoandar', script: 'scrapers/quintoandar.js', saida: 'data/quintoandar.json', grupo: 'DF', sites: ['quintoandar'] },
  { nome: 'chaves_mercadolivre', script: 'scrapers/chaves_mercadolivre.js', saida: 'data/chaves_mercadolivre.json', grupo: 'DF', sites: ['chaves', 'ml'] },
  { nome: 'outros', script: 'scrapers/outros.js', saida: 'data/outros.json', grupo: 'DF', sites: ['loft', 'lugarcerto', 'casamineira', 'netimoveis'] },
];

// ------------------------------------------------------------------ args
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ONLY = arg('only') ? arg('only').split(',') : null;
// sem = sem bloqueio; com = bloqueio + cache de scripts FRIO (1ª execução); quente = bloqueio + cache já populado (regime)
const MODES = (arg('modes', 'sem,com')).split(',');
const PAUSA_S = Number(arg('pausa', 20));
const CONC = Number(arg('conc', 3));
const TIMEOUT_MIN = Number(arg('timeout', 40));
const MERGE = process.argv.includes('--merge'); // mescla com medicao_trafego.json existente

const MB = (b) => b / 1e6;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------------ sandbox + backup / restauração
// Os crawlers gravam em <raiz>/data e <raiz>/data_ss (caminhos relativos a __dirname). Para NUNCA
// tocar nos dados reais, cada execução roda numa CÓPIA de scrapers/ + monitor/instrument*.js dentro
// de um diretório sandbox (node_modules via symlink). Além disso data/ e data_ss/ reais recebem
// backup e são verificados/restaurados no fim (inclusive em SIGINT/SIGTERM/exceção).
const SCRATCH = process.env.MEDICAO_TMP || path.join(require('os').tmpdir(), 'medicao_trafego');
const STAMP = Date.now();
const BACKUP = path.join(SCRATCH, `medicao_backup_${STAMP}`);
const SANDBOX = path.join(SCRATCH, `medicao_sandbox_${STAMP}`);
const md5 = (f) => require('crypto').createHash('md5').update(fs.readFileSync(f)).digest('hex');
const hashes = {};
function preparaSandbox() {
  fs.mkdirSync(path.join(SANDBOX, 'monitor'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scrapers'), path.join(SANDBOX, 'scrapers'), { recursive: true });
  for (const f of ['instrument.js', 'instrument_preload.js']) fs.copyFileSync(path.join(__dirname, f), path.join(SANDBOX, 'monitor', f));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(SANDBOX, 'package.json'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(SANDBOX, 'node_modules'), 'dir');
  // dados atuais como ponto de partida (alguns crawlers podem ler a saída anterior)
  for (const d of ['data', 'data_ss']) if (fs.existsSync(path.join(ROOT, d))) fs.cpSync(path.join(ROOT, d), path.join(SANDBOX, d), { recursive: true });
  log('sandbox em', SANDBOX);
}
function backup() {
  for (const d of ['data', 'data_ss']) {
    const src = path.join(ROOT, d);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(BACKUP, d), { recursive: true });
    for (const f of fs.readdirSync(src)) { const a = path.join(src, f); if (fs.statSync(a).isFile()) hashes[path.join(d, f)] = md5(a); }
  }
  log('backup de data/ e data_ss/ em', BACKUP);
}
function restauraTudo() {
  let mudou = 0;
  for (const d of ['data', 'data_ss']) {
    const bdir = path.join(BACKUP, d);
    const ddir = path.join(ROOT, d);
    if (!fs.existsSync(bdir)) continue;
    for (const f of fs.existsSync(ddir) ? fs.readdirSync(ddir) : []) if (!fs.existsSync(path.join(bdir, f))) { fs.rmSync(path.join(ddir, f), { recursive: true }); mudou++; }
    for (const f of fs.readdirSync(bdir)) {
      const rel = path.join(d, f);
      const dst = path.join(ROOT, rel);
      if (!fs.existsSync(dst) || md5(dst) !== hashes[rel]) { fs.copyFileSync(path.join(bdir, f), dst); mudou++; }
    }
  }
  for (const [rel, h] of Object.entries(hashes)) if (md5(path.join(ROOT, rel)) !== h) throw new Error('restauração não confere: ' + rel);
  log(`data/ e data_ss/ verificados (${Object.keys(hashes).length} arquivos idênticos ao backup; ${mudou} restaurados). Backup mantido em ${BACKUP}`);
}

// ------------------------------------------------------------------ nettop (bytes no fio por processo)
const fio = { porPid: new Map(), tree: new Map(), ok: false }; // pid -> {in,out}; pid -> rootPid
let nettopProc = null;
function iniciaNettop() {
  try {
    // via `script` (pty) para o nettop não bufferizar a saída
    nettopProc = spawn('script', ['-q', '/dev/null', 'nettop', '-P', '-d', '-L', '0', '-s', '1', '-x', '-J', 'bytes_in,bytes_out'],
      { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  } catch { return; }
  nettopProc.on('error', () => { fio.ok = false; });
  fio.ok = true;
  let buf = '';
  nettopProc.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = l.match(/^(.*)\.(\d+),(\d+),(\d+),/);
      if (!m) continue;
      const pid = Number(m[2]);
      const e = fio.porPid.get(pid) || { in: 0, out: 0, nome: m[1] };
      e.in += Number(m[3]); e.out += Number(m[4]);
      fio.porPid.set(pid, e);
    }
  });
}
function atualizaArvore(roots) {
  // mapeia descendentes (Chromium, helpers) de cada processo raiz em execução
  let out;
  try { out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }); } catch { return; }
  const pais = new Map();
  for (const l of out.trim().split('\n')) { const [p, pp] = l.trim().split(/\s+/).map(Number); pais.set(p, pp); }
  for (const [pid] of pais) {
    let x = pid; let n = 0;
    while (x > 1 && n++ < 50) { if (roots.has(x)) { fio.tree.set(pid, x); break; } x = pais.get(x); }
  }
}
function fioDe(root) {
  let i = 0, o = 0;
  for (const [pid, e] of fio.porPid) if (pid === root || fio.tree.get(pid) === root) { i += e.in; o += e.out; }
  return { bytesIn: i, bytesOut: o };
}

// ------------------------------------------------------------------ execução de um coletor
const rodando = new Set(); // root pids
function mataFilhos() { for (const pid of rodando) { try { process.kill(-pid, 'SIGKILL'); } catch {} } }
function contaAnuncios(arq) {
  try {
    const d = JSON.parse(fs.readFileSync(arq, 'utf8'));
    const lista = Array.isArray(d) ? d : d.anuncios || d.itens || [];
    return { n: lista.length, links: lista.map((a) => a.link || a.url || a.id).filter(Boolean) };
  } catch { return { n: null, links: [] }; }
}

function rodaUma(c, modo) {
  return new Promise((resolve) => {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    const statsFile = path.join(RUNS_DIR, `${c.nome}_${modo}.stats.json`);
    const logFile = path.join(RUNS_DIR, `${c.nome}_${modo}.log`);
    const saidaAbs = path.join(SANDBOX, c.saida);
    try { fs.rmSync(statsFile); } catch {}
    const mtime0 = fs.existsSync(saidaAbs) ? fs.statSync(saidaAbs).mtimeMs : 0;
    const t0 = Date.now();
    const logFd = fs.openSync(logFile, 'w');
    const cacheDir = path.join(RUNS_DIR, 'cache_' + c.nome);
    if (modo === 'com') fs.rmSync(cacheDir, { recursive: true, force: true });
    const ch = spawn(process.execPath, ['-r', './monitor/instrument_preload.js', c.script], {
      cwd: SANDBOX, detached: true, stdio: ['ignore', logFd, logFd],
      env: { ...process.env, INSTRUMENT_BLOCK: modo === 'sem' ? '0' : '1', INSTRUMENT_CACHE_DIR: cacheDir, INSTRUMENT_STATS_FILE: statsFile },
    });
    rodando.add(ch.pid);
    log(`>> ${c.nome} [${modo} bloqueio] pid ${ch.pid}`);
    const to = setTimeout(() => { log(`!! ${c.nome} [${modo}] timeout; matando`); try { process.kill(-ch.pid, 'SIGTERM'); } catch { ch.kill('SIGTERM'); } }, TIMEOUT_MIN * 60000);
    ch.on('exit', (code) => {
      clearTimeout(to);
      fs.closeSync(logFd);
      const ms = Date.now() - t0;
      setTimeout(() => { // espera o último intervalo do nettop
        rodando.delete(ch.pid);
        let st = null; try { st = JSON.parse(fs.readFileSync(statsFile, 'utf8')); } catch {}
        const escreveu = fs.existsSync(saidaAbs) && fs.statSync(saidaAbs).mtimeMs > mtime0;
        const { n, links } = escreveu ? contaAnuncios(saidaAbs) : { n: null, links: [] };
        if (escreveu) fs.copyFileSync(saidaAbs, path.join(RUNS_DIR, `${c.nome}_${modo}.json`));
        const w = fio.ok ? fioDe(ch.pid) : null;
        const r = {
          coletor: c.nome, grupo: c.grupo, modo, exitCode: code, segundos: Math.round(ms / 1000), anuncios: n,
          requests: st ? st.requests : null, bloqueados: st ? st.blocked : null, cacheHits: st ? st.cacheHits : null,
          bytesOut: st ? st.bytesOut : null, bytesIn: st ? st.bytesIn : null,
          fioBytesOut: w ? w.bytesOut : null, fioBytesIn: w ? w.bytesIn : null,
          topHosts: st ? Object.fromEntries(Object.entries(st.porHost).slice(0, 15)) : null,
          porTipo: st ? st.porTipo : null, _links: links,
        };
        log(`<< ${c.nome} [${modo}] exit ${code} ${r.segundos}s anúncios ${n} req ${r.requests} out ${r.bytesOut != null ? MB(r.bytesOut).toFixed(2) : '?'}MB in ${r.bytesIn != null ? MB(r.bytesIn).toFixed(2) : '?'}MB | fio out ${w ? MB(w.bytesOut).toFixed(2) : '?'}MB in ${w ? MB(w.bytesIn).toFixed(2) : '?'}MB`);
        resolve(r);
      }, 2500);
    });
  });
}

async function rodaColetor(c) {
  const res = [];
  for (const [i, m] of MODES.entries()) {
    if (i) await new Promise((r) => setTimeout(r, PAUSA_S * 1000)); // alivia rate-limit (DFimóveis 429)
    res.push(await rodaUma(c, m));
  }
  const a = res.find((r) => r.modo === 'sem');
  if (a && a.anuncios != null) {
    const sa = new Set(a._links);
    for (const b of res.filter((r) => r !== a && r.anuncios != null)) {
      const sb = new Set(b._links);
      b.diff = { soSemBloqueio: [...sa].filter((x) => !sb.has(x)), soComBloqueio: [...sb].filter((x) => !sa.has(x)) };
    }
  }
  return res;
}

// ------------------------------------------------------------------ estimativas
// Deploy alvo: GitHub Actions (ubuntu-latest). run.js roda os coletores de um grupo EM SEQUÊNCIA,
// então o tempo do job = soma dos tempos + overhead (checkout, npm ci c/ cache, Chromium c/ cache).
// O GitHub cobra por job arredondando para cima em minutos.
const OVERHEAD_MIN = Number(arg('overhead', 1.5));
function estimativas(resultados) {
  const com = [];
  for (const nome of new Set(resultados.map((r) => r.coletor))) {
    const q = resultados.find((r) => r.coletor === nome && r.modo === 'quente') || resultados.find((r) => r.coletor === nome && r.modo === 'com');
    if (q) com.push(q);
  }
  const sem = resultados.filter((r) => r.modo === 'sem');
  const agrega = (lista, g) => {
    const l = lista.filter((r) => r.grupo === g);
    const s = (k) => l.reduce((t, r) => t + (r[k] || 0), 0);
    const seg = s('segundos');
    return { coletores: l.length, segundos: seg, minutosJob: Math.ceil(seg / 60 + OVERHEAD_MIN), httpOut: s('bytesOut'), httpIn: s('bytesIn'), fioOut: s('fioBytesOut'), fioIn: s('fioBytesIn') };
  };
  const base = { SSJB: agrega(com, 'SSJB'), DF: agrega(com, 'DF') };
  const baseSem = { SSJB: agrega(sem, 'SSJB'), DF: agrega(sem, 'DF') };
  const cen = [
    { nome: '(a) ssjb a cada 30 min + df a cada 6 h', ssjbMin: 30, dfH: 6 },
    { nome: '(b) ssjb a cada 60 min + df a cada 12 h', ssjbMin: 60, dfH: 12 },
  ];
  const DIAS = 30;
  const GB = (b) => +(b / 1e9).toFixed(1);
  return {
    premissas: `30 dias; execuções COM bloqueio (cache de scripts frio); job = soma dos coletores do grupo (em sequência) + ${OVERHEAD_MIN} min de overhead, arredondado p/ cima; tráfego "fio" medido via nettop no Mac (HTTP+TLS+TCP).`,
    porExecucao: base,
    porExecucaoSemBloqueio: baseSem,
    cenarios: cen.map((c) => {
      const nS = (DIAS * 24 * 60) / c.ssjbMin, nD = (DIAS * 24) / c.dfH;
      const calc = (b, k) => b.SSJB[k] * nS + b.DF[k] * nD;
      const minutos = base.SSJB.minutosJob * nS + base.DF.minutosJob * nD;
      return {
        ...c, execSSJB: nS, execDF: nD,
        minutosActions: minutos, excedenteSePrivado2000: Math.max(0, minutos - 2000),
        entradaGB: GB(calc(base, 'fioIn')), saidaGB: GB(calc(base, 'fioOut')),
        entradaGBsemBloqueio: GB(calc(baseSem, 'fioIn')), saidaGBsemBloqueio: GB(calc(baseSem, 'fioOut')),
      };
    }),
  };
}

function tabela(resultados) {
  const f = (b) => (b == null ? '   ?' : MB(b).toFixed(2));
  const linhas = [['coletor', 'modo', 'req', 'bloq', 'cache', 'MB saída(HTTP)', 'MB entrada(HTTP)', 'MB saída(fio)', 'MB entrada(fio)', 'anúncios', 'tempo(s)']];
  for (const r of resultados) linhas.push([r.coletor, r.modo, r.requests, r.bloqueados, r.cacheHits, f(r.bytesOut), f(r.bytesIn), f(r.fioBytesOut), f(r.fioBytesIn), r.anuncios, r.segundos]);
  const w = linhas[0].map((_, i) => Math.max(...linhas.map((l) => String(l[i] ?? '').length)));
  return linhas.map((l) => l.map((x, i) => String(x ?? '').padEnd(w[i])).join(' | ')).join('\n');
}

// ------------------------------------------------------------------ main
const RECALC = process.argv.includes('--recalc'); // só recalcula estimativas do JSON existente
if (RECALC) {
  const j = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
  j.estimativasMensais = estimativas(j.resultados);
  fs.writeFileSync(OUT_JSON, JSON.stringify(j, null, 2));
  console.log(tabela(j.resultados));
  console.log(JSON.stringify(j.estimativasMensais, null, 2));
  process.exit(0);
}
(async () => {
  const lista = COLETORES.filter((c) => !ONLY || ONLY.includes(c.nome));
  backup();
  let restaurado = false;
  const fim = () => { if (!restaurado) { restaurado = true; mataFilhos(); try { restauraTudo(); } catch (e) { console.error('restauração falhou; backup em', BACKUP, e); } } };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { fim(); process.exit(130); });
  process.on('uncaughtException', (e) => { console.error(e); fim(); process.exit(1); });
  process.on('exit', fim);
  preparaSandbox();
  iniciaNettop();
  const arv = setInterval(() => atualizaArvore(rodando), 700);

  const resultados = [];
  const fila = [...lista];
  const ativos = new Map(); // nome -> {c, p}
  try {
    await new Promise((resolveAll) => {
      const tick = () => {
        if (!fila.length && !ativos.size) return resolveAll();
        while (ativos.size < CONC) {
          const ocupados = new Set([...ativos.values()].flatMap((a) => a.c.sites));
          const i = fila.findIndex((c) => !c.sites.some((s) => ocupados.has(s)));
          if (i < 0) break;
          const c = fila.splice(i, 1)[0];
          const p = rodaColetor(c).then((r) => { resultados.push(...r); ativos.delete(c.nome); tick(); });
          ativos.set(c.nome, { c, p });
        }
      };
      tick();
    });
  } finally {
    clearInterval(arv);
    if (nettopProc) { try { process.kill(-nettopProc.pid, 'SIGTERM'); } catch { nettopProc.kill(); } }
    fim();
  }

  let todos = resultados;
  if (MERGE && fs.existsSync(OUT_JSON)) {
    const ant = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8')).resultados || [];
    const chave = (r) => r.coletor + '|' + r.modo;
    const novos = new Set(resultados.map(chave));
    todos = [...ant.filter((r) => !novos.has(chave(r))), ...resultados];
  }
  const ordem = COLETORES.map((c) => c.nome);
  const om = ['sem', 'com', 'quente'];
  todos.sort((a, b) => ordem.indexOf(a.coletor) - ordem.indexOf(b.coletor) || om.indexOf(a.modo) - om.indexOf(b.modo));
  const est = estimativas(todos);
  const saida = {
    geradoEm: new Date().toISOString(),
    nota: 'HTTP = headers+corpos (Playwright request.sizes() + undici). fio = bytes por processo via nettop do macOS (inclui TLS/TCP/ACKs/QUIC). diff = links presentes só numa das execuções (sem x com bloqueio).',
    resultados: todos.map(({ _links, ...r }) => r),
    estimativasMensais: est,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(saida, null, 2));
  console.log('\n' + tabela(todos));
  console.log('\nEstimativas mensais (GitHub Actions, execuções com bloqueio):');
  for (const c of est.cenarios) console.log(`  ${c.nome}: ${c.minutosActions} min de Actions; entrada ≈ ${c.entradaGB} GB, saída ≈ ${c.saidaGB} GB`);
  for (const r of todos.filter((x) => x.modo !== 'sem' && x.diff && (x.diff.soSemBloqueio.length || x.diff.soComBloqueio.length))) {
    console.log(`\n[${r.coletor}/${r.modo}] diferenças de anúncios: só sem bloqueio ${r.diff.soSemBloqueio.length}, só com bloqueio ${r.diff.soComBloqueio.length}`);
  }
  console.log('\ngravado', path.relative(ROOT, OUT_JSON));
})().catch((e) => { console.error(e); process.exitCode = 1; });
