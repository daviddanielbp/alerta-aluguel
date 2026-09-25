'use strict';
// Preload: node -r ./monitor/instrument_preload.js scrapers/x.js
// Env: INSTRUMENT_BLOCK=0|1 (padrão 1), INSTRUMENT_STATS_FILE=caminho.json (opcional),
//      INSTRUMENT_CSS_OK=host1,host2 (sites onde o CSS é liberado)
//      INSTRUMENT_SEM_JS=dom1,dom2 (substitui a lista de portais com JS próprio bloqueado; vazio = nenhum)
//      INSTRUMENT_CACHE=0 desliga o cache persistente de scripts; INSTRUMENT_CACHE_DIR=dir (padrão monitor/.cache_http)
// No exit imprime uma linha "__INSTRUMENT_STATS__{json}" em stdout (e grava no arquivo, se dado).
const fs = require('fs');
const { instrument, getStats } = require('./instrument');
const t0 = Date.now();
instrument({
  block: process.env.INSTRUMENT_BLOCK !== '0',
  cache: process.env.INSTRUMENT_CACHE !== '0',
  ...(process.env.INSTRUMENT_CACHE_DIR ? { cacheDir: process.env.INSTRUMENT_CACHE_DIR } : {}),
  ...(process.env.INSTRUMENT_SEM_JS != null ? { semJs: process.env.INSTRUMENT_SEM_JS.split(',').filter(Boolean) } : {}),
  cssPermitido: (process.env.INSTRUMENT_CSS_OK || '').split(',').filter(Boolean),
});
let feito = false;
process.on('exit', (code) => {
  if (feito) return;
  feito = true;
  const s = { ...getStats(), exitCode: code, ms: Date.now() - t0 };
  if (process.env.INSTRUMENT_STATS_FILE) { try { fs.writeFileSync(process.env.INSTRUMENT_STATS_FILE, JSON.stringify(s, null, 2)); } catch {} }
  try { fs.writeSync(1, '\n__INSTRUMENT_STATS__' + JSON.stringify(s) + '\n'); } catch {}
});
