// Processo filho para coletores que exportam `async coletar({precoMax})` (ss_jb_a, ss_jb_b).
// Uso: node --require monitor/coletores/preload.js monitor/coletores/modulo.js <arquivo-do-scraper> <saida.json>
const fs = require('fs');
const path = require('path');

const [arquivo, saida] = process.argv.slice(2);
const precoMax = Number(process.env.PRECO_MAX) || 1200;

(async () => {
  const mod = require(path.resolve(arquivo));
  if (typeof mod.coletar !== 'function') throw new Error(`${arquivo} não exporta coletar()`);
  const itens = await mod.coletar({ precoMax });
  const extra = mod.coletar.ultimoStats || mod.coletar.ultimasOcorrencias || null;
  fs.writeFileSync(saida, JSON.stringify({ itens, extra }));
  process.exit(0); // garante saída mesmo com handles pendentes
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
