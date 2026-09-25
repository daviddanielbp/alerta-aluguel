// Configuração do monitor. Lê o .env da raiz do projeto (parse simples, sem dependências)
// e aplica valores padrão. Variáveis de ambiente reais têm precedência sobre o .env.
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const STATE_DIR = path.join(__dirname, 'state');

function lerEnv(arquivo) {
  const out = {};
  if (!fs.existsSync(arquivo)) return out;
  for (let linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    linha = linha.trim();
    if (!linha || linha.startsWith('#')) continue;
    const m = linha.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, ''); // comentário no fim da linha (só sem aspas)
    out[m[1]] = v;
  }
  return out;
}

const env = { ...lerEnv(path.join(RAIZ, '.env')), ...process.env };
const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const lista = (v) => String(v || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);

// Coletores de cada grupo. ssjb = busca focada em São Sebastião/Jardim Botânico (módulos com coletar()).
// df = crawlers do DF inteiro (scripts standalone, rodados por wrapper em processo filho).
const COLETORES = {
  ss_jb_a: { tipo: 'modulo', arquivo: 'scrapers/ss_jb_a.js', timeoutMin: 25 },
  ss_jb_b: { tipo: 'modulo', arquivo: 'scrapers/ss_jb_b.js', timeoutMin: 20 },
  olx: { tipo: 'script', arquivo: 'scrapers/olx.js', saida: 'olx.json', timeoutMin: 30 },
  dfimoveis: { tipo: 'script', arquivo: 'scrapers/dfimoveis.js', saida: 'dfimoveis.json', timeoutMin: 30 },
  imovelweb: { tipo: 'script', arquivo: 'scrapers/imovelweb.js', saida: 'imovelweb.json', timeoutMin: 20 },
  zap_vivareal: { tipo: 'script', arquivo: 'scrapers/zap_vivareal.js', saida: 'zap_vivareal.json', timeoutMin: 20 },
  quintoandar: { tipo: 'script', arquivo: 'scrapers/quintoandar.js', saida: 'quintoandar.json', timeoutMin: 15 },
  chaves_mercadolivre: { tipo: 'script', arquivo: 'scrapers/chaves_mercadolivre.js', saida: 'chaves_mercadolivre.json', timeoutMin: 20 },
  outros: { tipo: 'script', arquivo: 'scrapers/outros.js', saida: 'outros.json', timeoutMin: 20 },
};

const GRUPOS = {
  ssjb: lista(env.GRUPO_SSJB).length ? lista(env.GRUPO_SSJB) : ['ss_jb_a', 'ss_jb_b'],
  df: lista(env.GRUPO_DF).length ? lista(env.GRUPO_DF)
    : ['olx', 'dfimoveis', 'imovelweb', 'zap_vivareal', 'quintoandar', 'chaves_mercadolivre', 'outros'],
};
GRUPOS.todos = [...new Set([...GRUPOS.ssjb, ...GRUPOS.df])];

// Timeout individual pode ser sobrescrito: TIMEOUT_OLX_MIN=40
for (const [nome, c] of Object.entries(COLETORES)) c.timeoutMin = num(env[`TIMEOUT_${nome.toUpperCase()}_MIN`], c.timeoutMin);

const regioesAlerta = String(env.REGIOES_ALERTA || 'todas').trim();

module.exports = {
  RAIZ,
  STATE_DIR,
  TELEGRAM_TOKEN: env.TELEGRAM_TOKEN || '',
  TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID || '',
  PRECO_MAX: num(env.PRECO_MAX, 1200),
  // 'todas' ou lista separada por vírgula (nomes como em scrapers/common.js REGIOES)
  REGIOES_ALERTA: /^todas?$/i.test(regioesAlerta) || !regioesAlerta ? null : lista(regioesAlerta),
  // São Sebastião até esta distância do terminal ganha 🔥
  RAIO_QUENTE_KM: num(env.RAIO_QUENTE_KM, 1.5),
  // Acima deste número de novos numa rodada, agrupa várias ofertas por mensagem
  LIMITE_INDIVIDUAIS: num(env.LIMITE_INDIVIDUAIS, 15),
  // Frequências sugeridas (minutos) - usadas por `run.js --cron` para gerar as linhas do crontab
  FREQ_MIN: { ssjb: num(env.FREQ_SSJB_MIN, 30), df: num(env.FREQ_DF_MIN, 180) },
  // Lock mais velho que isso é considerado órfão
  LOCK_MAX_MIN: num(env.LOCK_MAX_MIN, 180),
  // Esquece anúncios não vistos há mais de N dias
  ESQUECER_DIAS: num(env.ESQUECER_DIAS, 90),
  // Bloquear imagens/fontes/mídia nos navegadores (se monitor/instrument.js existir)
  BLOQUEAR_RECURSOS: !/^(0|false|nao|não)$/i.test(env.BLOQUEAR_RECURSOS || '1'),
  COLETORES,
  GRUPOS,
};
