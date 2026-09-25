// Carregado com `node --require` em todo processo filho de coletor:
//  - ajusta FILTRO.precoMax de scrapers/common.js para PRECO_MAX
//  - ativa monitor/instrument.js (bloqueio de recursos + medição de tráfego) se existir
//  - ao sair, grava as estatísticas de tráfego em $MONITOR_STATS_FILE
const fs = require('fs');
const path = require('path');

const precoMax = Number(process.env.PRECO_MAX) || 1200;
try { require(path.join(__dirname, '..', '..', 'scrapers', 'common.js')).FILTRO.precoMax = precoMax; } catch {}

let inst = null;
try {
  inst = require(path.join(__dirname, '..', 'instrument.js'));
  if (typeof inst.instrument === 'function') inst.instrument({ block: process.env.MONITOR_BLOCK !== '0', cssPermitido: (process.env.INSTRUMENT_CSS_OK || '').split(',').filter(Boolean) });
  else inst = null;
} catch (e) {
  inst = null;
  if (e.code !== 'MODULE_NOT_FOUND') console.error('[monitor] instrument.js falhou:', e.message);
}

process.on('exit', () => {
  const f = process.env.MONITOR_STATS_FILE;
  if (!f) return;
  const out = { instrument: !!inst, maxRSS_node_kb: process.resourceUsage().maxRSS };
  try { if (inst && inst.getStats) out.trafego = inst.getStats(); } catch (e) { out.trafego_erro = e.message; }
  try { fs.writeFileSync(f, JSON.stringify(out)); } catch {}
});
