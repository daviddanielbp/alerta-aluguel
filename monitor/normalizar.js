// Normalização + filtro + dedupe — mesma lógica de merge.js (e a limpeza de condomínio de ss_jb_merge.js),
// em forma de função para o monitor.
const { passaFiltro, regiaoPermitida } = require('../scrapers/common');

// Tempo médio aproximado até a UnB (Campus Darcy Ribeiro), ônibus/metrô, em minutos (de merge.js).
const TEMPO_UNB = {
  'Vila Planalto': 15, 'Asa Norte': 15, 'Noroeste': 20, 'Varjão': 25, 'Lago Norte': 25, 'Taquari': 35,
  'Asa Sul': 25, 'Granja do Torto': 30, 'Cruzeiro': 30, 'Sudoeste': 30, 'Octogonal': 35,
  'Vila Telebrasília': 30, 'Paranoá': 35, 'Lago Sul': 35, 'Itapoã': 45, 'Guará': 40,
  'SCIA': 40, 'Estrutural': 40, 'Setor de Indústria e Abastecimento': 40, 'Candangolândia': 40,
  'Núcleo Bandeirante': 45, 'Park Way': 45, 'Sobradinho': 50, 'Grande Colorado': 45,
  'Jardim Botânico': 45, 'Riacho Fundo': 55, 'Águas Claras': 55, 'São Sebastião': 55,
  'Vicente Pires': 55, 'Taguatinga': 60,
};
// Correções manuais / descartes verificados (de merge.js).
const CORRECOES = { 'id-46209782': { regiao: 'Itapoã', bairro: 'Itapoã Parque (anunciado como Asa Norte)' } };
const DESCARTAR = ['id-353732700'];
const FORA_DF = /valpara[ií]so|goi[aá]s\b|- ?GO\b|\/GO\b|novo gama|luzi[aâ]nia|[aá]guas lindas|cidade ocidental|santo ant[oô]nio do descoberto|planaltina de goi|formosa|corumb/i;
const NAO_RESID = /quitinete|kitchenette|sala comercial|loja|ponto comercial|galp[aã]o|di[aá]ria|temporada/i;

// Link canônico: sem query/hash, sem barra final, host minúsculo sem "www.".
function linkNorm(l) {
  if (!l) return null;
  try {
    const u = new URL(l);
    return (u.host.replace(/^www\./, '').toLowerCase() + u.pathname.replace(/\/+$/, '')).toLowerCase();
  } catch { return String(l).split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase(); }
}
const zapId = (l) => (l && /zapimoveis|vivareal/.test(l) && (l.match(/id-(\d+)/) || [])[1]) || null;

// Chaves estáveis do anúncio (qualquer uma que já esteja no estado => já visto).
function chavesDe(a) {
  const links = [a.link, a.link_alt, a.link_vivareal, ...(a.outros_links || [])].filter(Boolean);
  const ks = new Set();
  for (const l of links) {
    const z = zapId(l);
    ks.add(z ? 'zap:' + z : 'url:' + linkNorm(l));
  }
  if (a.id_site && a.site) ks.add(`id:${String(a.site).toLowerCase()}:${a.id_site}`);
  return [...ks];
}
// Chave "fuzzy" entre portais: mesmo preço, área, quartos e região (só com área conhecida).
const chaveFuzzy = (a) => (a.area_m2 != null ? `fz:${a.preco}|${a.area_m2}|${a.quartos}|${a.regiao}` : null);

function normalizar(brutos, { regioesAlerta = null } = {}) {
  const seen = new Set();
  const out = [];
  const descartes = {};
  const desc = (m) => { descartes[m] = (descartes[m] || 0) + 1; };
  for (const a0 of brutos) {
    if (!a0 || !a0.link) { desc('sem link'); continue; }
    const a = { ...a0, _coletores: [a0._coletor].filter(Boolean) };
    const ln = linkNorm(a.link);
    if (seen.has(ln)) { const p = out.find((o) => o._ln === ln); if (p) p._coletores = [...new Set([...p._coletores, ...a._coletores])]; desc('link repetido'); continue; }
    for (const [k, v] of Object.entries(CORRECOES)) if (a.link.includes(k)) Object.assign(a, v);
    a.regiao = a.regiao || regiaoPermitida([a.bairro, a.endereco, a.titulo].join(' '));
    if (DESCARTAR.some((d) => a.link.includes(d))) { desc('descarte manual'); continue; }
    if (FORA_DF.test([a.cidade, a.endereco, a.bairro, a.titulo].join(' '))) { desc('fora do DF'); continue; }
    if (!a.regiao) { desc('região não permitida'); continue; }
    if (!passaFiltro(a)) { desc('filtro (preço/área/quartos/kitnet)'); continue; }
    if (NAO_RESID.test((a.titulo || '') + ' ' + (a.tipo || ''))) { desc('comercial/temporada'); continue; }
    if (a.condominio != null && (a.condominio <= 0 || a.condominio === a.preco)) a.condominio = null;
    if ((a.area_m2 && a.area_m2 > 1000) || /corumb|goi[aâ]nia|valpara|luzi[aâ]nia|[aá]guas lindas|novo gama|formosa/i.test(a.titulo || '')) { desc('lixo'); continue; }
    if (regioesAlerta && !regioesAlerta.includes(a.regiao)) { desc('fora de REGIOES_ALERTA'); continue; }
    // ZAP e VivaReal compartilham o mesmo id de anúncio: mantém um e guarda o outro link
    const gid = zapId(a.link);
    if (gid) {
      const prev = out.find((o) => o._gid === gid);
      if (prev) {
        if (prev.link !== a.link) prev.link_alt = a.link;
        prev._coletores = [...new Set([...prev._coletores, ...a._coletores])];
        seen.add(ln); desc('ZAP/VivaReal mesmo id'); continue;
      }
      a._gid = gid;
    }
    // mesmo imóvel repetido no mesmo site
    const k = [a.site, a.preco, a.area_m2, a.quartos, (a.bairro || '').toLowerCase(), (a.titulo || '').toLowerCase().slice(0, 40)].join('|');
    if (seen.has(k)) { desc('repetido no mesmo site'); continue; }
    seen.add(ln); seen.add(k);
    a._ln = ln;
    a.tempo_unb_min = TEMPO_UNB[a.regiao] ?? null;
    out.push(a);
  }

  // Mesmo imóvel em portais diferentes: mesmo preço, área, quartos e região.
  const grupos = new Map();
  const final = [];
  for (const a of out) {
    const k = chaveFuzzy(a);
    if (!k) { final.push(a); continue; }
    const prev = grupos.get(k);
    if (prev) {
      prev.outros_links = [...new Set([...(prev.outros_links || []), a.link, ...(a.link_alt ? [a.link_alt] : [])])];
      if (!prev.data_publicacao || (a.data_publicacao && a.data_publicacao > prev.data_publicacao)) prev.data_publicacao = a.data_publicacao;
      for (const f of ['condominio', 'banheiros', 'vagas', 'lat', 'lon', 'cep', 'endereco']) prev[f] ??= a[f];
      if (prev.geo_aprox && a.lat != null && !a.geo_aprox) { prev.lat = a.lat; prev.lon = a.lon; prev.geo_aprox = false; }
      prev._coletores = [...new Set([...prev._coletores, ...a._coletores])];
      desc('mesmo imóvel em outro portal');
      continue;
    }
    grupos.set(k, a); final.push(a);
  }
  for (const a of final) { delete a._gid; delete a._ln; delete a._coletor; }
  return { lista: final, descartes };
}

module.exports = { normalizar, chavesDe, chaveFuzzy, linkNorm, TEMPO_UNB };
