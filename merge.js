// Junta data/*.json, deduplica e gera resultado.json + resultado.md ordenados.
const fs = require('fs');
const path = require('path');
const { passaFiltro, regiaoPermitida } = require('./scrapers/common');

// Tempo médio aproximado até a UnB (Campus Darcy Ribeiro), ônibus/metrô, em minutos.
const TEMPO_UNB = {
  'Vila Planalto': 15, 'Asa Norte': 15, 'Noroeste': 20, 'Varjão': 25, 'Lago Norte': 25, 'Taquari': 35,
  'Asa Sul': 25, 'Granja do Torto': 30, 'Cruzeiro': 30, 'Sudoeste': 30, 'Octogonal': 35,
  'Vila Telebrasília': 30, 'Paranoá': 35, 'Lago Sul': 35, 'Itapoã': 45, 'Guará': 40,
  'SCIA': 40, 'Estrutural': 40, 'Setor de Indústria e Abastecimento': 40, 'Candangolândia': 40,
  'Núcleo Bandeirante': 45, 'Park Way': 45, 'Sobradinho': 50, 'Grande Colorado': 45,
  'Jardim Botânico': 45, 'Riacho Fundo': 55, 'Águas Claras': 55, 'São Sebastião': 55,
  'Vicente Pires': 55, 'Taguatinga': 60,
};

// Correções manuais verificadas lendo a descrição do anúncio (portal rotulou a região errado).
const CORRECOES = {
  'id-46209782': { regiao: 'Itapoã', bairro: 'Itapoã Parque (anunciado como Asa Norte)' },
};
// Verificados como kitnet/fora do perfil lendo a descrição.
const DESCARTAR = ['id-353732700'];
const FORA_DF = /valpara[ií]so|goi[aá]s\b|- ?GO\b|\/GO\b|novo gama|luzi[aâ]nia|[aá]guas lindas|cidade ocidental|santo ant[oô]nio do descoberto|planaltina de goi|formosa|corumb/i;

const all = [];
for (const f of fs.readdirSync('data').filter((f) => f.endsWith('.json'))) {
  try { all.push(...JSON.parse(fs.readFileSync(path.join('data', f), 'utf8'))); }
  catch (e) { console.error('falha lendo', f, e.message); }
}

const seen = new Set();
const out = [];
for (const a of all) {
  if (!a || !a.link || seen.has(a.link)) continue;
  for (const [k, v] of Object.entries(CORRECOES)) if (a.link.includes(k)) Object.assign(a, v);
  a.regiao = a.regiao || regiaoPermitida([a.bairro, a.endereco, a.titulo].join(' '));
  if (DESCARTAR.some((d) => a.link.includes(d))) continue;
  if (FORA_DF.test([a.cidade, a.endereco, a.bairro, a.titulo].join(' '))) continue;
  if (!a.regiao || !passaFiltro(a)) continue;
  if (/quitinete|kitchenette|sala comercial|loja|ponto comercial|galp[aã]o|di[aá]ria|temporada/i.test((a.titulo || '') + ' ' + (a.tipo || ''))) continue;
  // lixo óbvio: terrenos/chácaras gigantes ou fora do DF
  if (a.condominio != null && a.condominio <= 0) a.condominio = null;
  if ((a.area_m2 && a.area_m2 > 1000) || /corumb|goi[aâ]nia|valpara|luzi[aâ]nia|[aá]guas lindas|novo gama|formosa/i.test(a.titulo || '')) continue;
  // ZAP e VivaReal compartilham o mesmo id de anúncio: mantém um e guarda o outro link
  const gid = /zapimoveis|vivareal/.test(a.link) && (a.link.match(/id-(\d+)/) || [])[1];
  if (gid) {
    const prev = out.find((o) => o._gid === gid);
    if (prev) { prev.link_alt = a.link; seen.add(a.link); continue; }
    a._gid = gid;
  }
  // mesmo imóvel repetido no mesmo site (mesmo preço/área/bairro/título)
  const k = [a.site, a.preco, a.area_m2, a.quartos, (a.bairro || '').toLowerCase(), (a.titulo || '').toLowerCase().slice(0, 40)].join('|');
  if (seen.has(k)) continue;
  seen.add(a.link); seen.add(k);
  a.tempo_unb_min = TEMPO_UNB[a.regiao] ?? null;
  out.push(a);
}

// Mesmo imóvel anunciado em portais diferentes: mesmo preço, área, quartos e região.
const grupos = new Map();
const final = [];
for (const a of out) {
  if (a.area_m2 == null) { final.push(a); continue; }
  const k = [a.preco, a.area_m2, a.quartos, a.regiao].join('|');
  const prev = grupos.get(k);
  if (prev) {
    prev.outros_links = [...(prev.outros_links || []), a.link];
    if (!prev.data_publicacao || (a.data_publicacao && a.data_publicacao > prev.data_publicacao)) prev.data_publicacao = a.data_publicacao;
    prev.condominio ??= a.condominio; prev.banheiros ??= a.banheiros; prev.vagas ??= a.vagas;
    continue;
  }
  grupos.set(k, a); final.push(a);
}
out.length = 0; out.push(...final);

// Vila Planalto primeiro, depois por preço crescente; empate -> mais recente.
out.sort((x, y) => (y.regiao === 'Vila Planalto') - (x.regiao === 'Vila Planalto')
  || x.preco - y.preco || String(y.data_publicacao || '').localeCompare(String(x.data_publicacao || '')));

out.forEach((a) => delete a._gid);
fs.writeFileSync('resultado.json', JSON.stringify(out, null, 2));
const brl = (n) => (n == null ? '—' : 'R$ ' + Number(n).toLocaleString('pt-BR'));
const lines = ['| # | Aluguel | Cond. | Região | Bairro | Tipo | m² | Qts | Banh | Vagas | ~Min UnB | Data | Site | Link |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
out.forEach((a, i) => lines.push(`| ${i + 1} | ${brl(a.preco)} | ${brl(a.condominio)} | ${a.regiao} | ${a.bairro || ''} | ${a.tipo || ''} | ${a.area_m2 ?? '?'} | ${a.quartos ?? '?'} | ${a.banheiros ?? '?'} | ${a.vagas ?? '-'} | ${a.tempo_unb_min ?? '?'} | ${a.data_publicacao || '?'}${a.data_tipo === 'atualizado' ? ' (atualiz.)' : ''} | ${a.site} | ${a.link} |`));
fs.writeFileSync('resultado.md', lines.join('\n') + '\n');
const porSite = {}; out.forEach((a) => (porSite[a.site] = (porSite[a.site] || 0) + 1));
const porReg = {}; out.forEach((a) => (porReg[a.regiao] = (porReg[a.regiao] || 0) + 1));
console.log('brutos', all.length, '-> final', out.length); console.log(porSite); console.log(porReg);
