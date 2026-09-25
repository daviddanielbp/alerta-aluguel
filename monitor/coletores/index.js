// Executa um coletor em PROCESSO FILHO (isolamento de erro, timeout confiável e memória devolvida
// ao sistema ao final — importante na VM de 1 GB). Nunca edita os scrapers originais:
//  - todo coletor é COPIADO para monitor/state/work/<x>/scrapers/ junto com um common.js "shim";
//    como os crawlers gravam em path.join(__dirname,'..','data' | 'data_ss',...), qualquer escrita cai
//    em monitor/state/work/<x>/ e os data/ e data_ss/ do projeto nunca são tocados (nem precisam existir).
//  - tipo 'modulo' (ss_jb_a/ss_jb_b): roda coletores/modulo.js, que chama coletar({precoMax}) da cópia.
//  - tipo 'script' (crawlers do DF): roda a cópia do script e lê work/<x>/data/<saida>.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const config = require('../config');

const RAIZ = config.RAIZ;
const WORK = path.join(config.STATE_DIR, 'work');
const LOGS = path.join(config.STATE_DIR, 'logs');
const PRELOAD = path.join(__dirname, 'preload.js');

function prepararScript(nome, c, precoMax) {
  const dir = path.join(WORK, nome);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'scrapers'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  let src = fs.readFileSync(path.join(RAIZ, c.arquivo), 'utf8');
  if (precoMax !== 1200) { // limites de preço fixos nas URLs de alguns crawlers
    const p = String(precoMax);
    src = src.replace(/(precoMax(?:imo)?=)1200\b/g, `$1${p}`)
      .replace(/(\bpe=)1200\b/g, `$1${p}`)
      .replace(/(priceMax:\s*')1200'/g, `$1${p}'`)
      .replace(/menos-1200-reales/g, `menos-${p}-reales`)
      .replace(/de-500-a-1200-reais/g, `de-500-a-${p}-reais`);
  }
  const alvo = path.join(dir, 'scrapers', path.basename(c.arquivo));
  fs.writeFileSync(alvo, src);
  // shim: reexporta o common.js real (FILTRO.precoMax já é ajustado no preload)
  fs.writeFileSync(path.join(dir, 'scrapers', 'common.js'),
    `module.exports = require(${JSON.stringify(path.join(RAIZ, 'scrapers', 'common.js'))});\n`);
  // idem para os demais módulos compartilhados dos crawlers
  for (const m of ['known.js']) fs.writeFileSync(path.join(dir, 'scrapers', m),
    `module.exports = require(${JSON.stringify(path.join(RAIZ, 'scrapers', m))});\n`);
  fs.mkdirSync(path.join(dir, 'data_ss'), { recursive: true });
  return { dir, alvo, saida: c.saida ? path.join(dir, 'data', c.saida) : path.join(dir, 'out.json') };
}

// Soma o RSS de toda a árvore de processos (node + chromium) — para medir memória de pico.
function rssArvoreKb(pidRaiz) {
  try {
    const linhas = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n');
    const filhos = new Map(); const rss = new Map();
    for (const l of linhas) {
      const [pid, ppid, r] = l.trim().split(/\s+/).map(Number);
      rss.set(pid, r);
      if (!filhos.has(ppid)) filhos.set(ppid, []);
      filhos.get(ppid).push(pid);
    }
    let total = 0; const pilha = [pidRaiz];
    while (pilha.length) { const p = pilha.pop(); total += rss.get(p) || 0; pilha.push(...(filhos.get(p) || [])); }
    return total;
  } catch { return null; }
}

// Mantém no log só os totais e os hosts que mais baixaram.
function resumirTrafego(t) {
  if (!t) return null;
  const { porHost, porTipo, ...tot } = t;
  const top = Object.entries(porHost || {}).sort((a, b) => (b[1].bytesIn || 0) - (a[1].bytesIn || 0)).slice(0, 3)
    .map(([h, v]) => [h, { req: v.requests, blk: v.blocked, kbIn: Math.round((v.bytesIn || 0) / 1024) }]);
  return { ...tot, mbIn: +((t.bytesIn || 0) / 1048576).toFixed(1), topHosts: Object.fromEntries(top) };
}

const semChaves = (o, ks) => Object.fromEntries(Object.entries(o).filter(([k]) => !ks.includes(k)));

function matarArvore(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

// Retorna { nome, itens, erro, seg, pico_rss_mb, trafego, extra, log }
async function executar(nome, { precoMax = config.PRECO_MAX, log = console.log } = {}) {
  const c = config.COLETORES[nome];
  if (!c) return { nome, itens: [], erro: `coletor desconhecido: ${nome}`, seg: 0 };
  fs.mkdirSync(LOGS, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  const t0 = Date.now();
  const statsFile = path.join(WORK, `${nome}.stats.json`);
  fs.rmSync(statsFile, { force: true });

  const p = prepararScript(nome, c, precoMax);
  const saida = p.saida, dir = p.dir;
  const args = c.tipo === 'modulo'
    ? ['--require', PRELOAD, path.join(__dirname, 'modulo.js'), p.alvo, saida]
    : ['--require', PRELOAD, p.alvo];

  const logFile = path.join(LOGS, `${nome}.log`);
  const logStream = fs.createWriteStream(logFile);
  logStream.write(`# ${new Date().toISOString()} node ${args.map((a) => path.relative(RAIZ, a) || a).join(' ')}\n`);
  let cauda = '';
  const guardar = (b) => { logStream.write(b); cauda = (cauda + b.toString()).slice(-2000); };

  const child = spawn(process.execPath, ['--max-old-space-size=384', ...args], {
    cwd: RAIZ, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...semChaves(process.env, ['SSJB_DEBUG', 'TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID']), PRECO_MAX: String(precoMax), MONITOR_STATS_FILE: statsFile, MONITOR_BLOCK: config.BLOQUEAR_RECURSOS ? '1' : '0' },
  });
  child.stdout.on('data', guardar);
  child.stderr.on('data', guardar);

  let pico = 0;
  const amostrar = () => { const r = rssArvoreKb(child.pid); if (r && r > pico) pico = r; };
  const amostrador = setInterval(amostrar, 3000);
  let estourou = false;
  const timer = setTimeout(() => { estourou = true; log(`[${nome}] timeout de ${c.timeoutMin} min — matando`); matarArvore(child); }, c.timeoutMin * 60000);

  const codigo = await new Promise((resolve) => {
    child.on('error', (e) => { guardar(Buffer.from(String(e))); resolve(-1); });
    child.on('exit', (code, sinal) => resolve(code ?? sinal));
  });
  clearTimeout(timer); clearInterval(amostrador);
  matarArvore(child); // garante que nenhum chromium órfão fique para trás
  await new Promise((r) => logStream.end(r));

  const res = { nome, itens: [], erro: null, seg: Math.round((Date.now() - t0) / 1000), pico_rss_mb: pico ? Math.round(pico / 1024) : null };
  try { const s = JSON.parse(fs.readFileSync(statsFile, 'utf8')); res.trafego = resumirTrafego(s.trafego); res.instrument = s.instrument; } catch {}
  try {
    const j = JSON.parse(fs.readFileSync(saida, 'utf8'));
    const itens = Array.isArray(j) ? j : j.itens;
    res.itens = Array.isArray(itens) ? itens : [];
    if (j.extra) res.extra = j.extra;
  } catch {
    res.erro = estourou ? `timeout (${c.timeoutMin} min)` : `saída não gerada (código ${codigo}): ${cauda.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`;
  }
  if (!res.erro && estourou) res.erro = `timeout (${c.timeoutMin} min)`;
  if (!res.erro && codigo !== 0) res.erro = `código de saída ${codigo}`;
  for (const a of res.itens) a._coletor = nome;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(statsFile, { force: true });
  return res;
}

module.exports = { executar };
