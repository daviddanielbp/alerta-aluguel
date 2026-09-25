// Marca como "já visto" (sem notificar) todo anúncio presente em arquivos JSON de coletas
// anteriores — ex.: a lista inicial que o usuário já recebeu em PDF/planilha.
//
//   node monitor/marcar_vistos.js resultado.json resultado_ss_jb.json data/*.json data_ss/*.json
//
// Anúncio já no estado (por link, id ou chave fuzzy) só ganha as chaves que faltarem.
const fs = require('fs');
const path = require('path');
const { chavesDe, chaveFuzzy } = require('./normalizar');

const ARQ = path.join(__dirname, 'state', 'vistos.json');
const estado = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

const idx = new Map(); const fz = new Map();
for (const [id, it] of Object.entries(estado.itens)) {
  for (const k of it.chaves || []) idx.set(k, id);
  if (it.fuzzy) fz.set(it.fuzzy, id);
}

let novos = 0, completados = 0, lidos = 0;
for (const arq of process.argv.slice(2)) {
  let lista;
  try { lista = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { continue; }
  if (!Array.isArray(lista)) continue;
  for (const a of lista) {
    if (!a || !a.link) continue;
    lidos++;
    const ks = chavesDe(a);
    const f = chaveFuzzy(a);
    const id = ks.map((k) => idx.get(k)).find(Boolean) || (f && fz.get(f));
    if (id) {
      const it = estado.itens[id];
      const faltam = ks.filter((k) => !it.chaves.includes(k));
      if (faltam.length) { it.chaves = [...it.chaves, ...faltam].sort(); completados++; }
      faltam.forEach((k) => idx.set(k, id));
      continue;
    }
    const nid = ks[0];
    estado.itens[nid] = {
      chaves: ks.sort(), fuzzy: f, primeiro_visto: hoje, ultimo_visto: hoje, motivo: 'lista_inicial', notificado: false,
      preco: a.preco, preco_inicial: a.preco, site: a.site, regiao: a.regiao || null, bairro: a.bairro || null,
      area_m2: a.area_m2 ?? null, quartos: a.quartos ?? null, titulo: (a.titulo || '').slice(0, 120), link: a.link,
      data_publicacao: a.data_publicacao || null,
    };
    ks.forEach((k) => idx.set(k, nid)); if (f) fz.set(f, nid);
    novos++;
  }
}

// mesma serialização determinística do run.js (chaves ordenadas)
const ordenar = (v) => (Array.isArray(v) ? v.map(ordenar) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordenar(v[k])])) : v);
fs.writeFileSync(ARQ, JSON.stringify(ordenar(estado), null, 1) + '\n');
console.log(`${lidos} anúncios lidos · ${novos} marcados como vistos · ${completados} completados com links extras · total ${Object.keys(estado.itens).length}`);
