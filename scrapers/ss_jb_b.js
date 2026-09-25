// Busca focada: aluguel residencial em São Sebastião e Jardim Botânico (DF).
// Sites: ZAP (+ link VivaReal, mesmo estoque), QuintoAndar, Chaves na Mão, Loft, Casa Mineira, Lugar Certo.
// Uso direto:  node scrapers/ss_jb_b.js   -> data_ss/ss_jb_b.json   (SSJB_AMPLO=1 liga as varreduras amplas)
// Uso como módulo:  const { coletar } = require('./scrapers/ss_jb_b'); const lista = await coletar({ precoMax: 1200, amplo: false });
// Por padrão só faz buscas por localidade. As varreduras do DF inteiro de Loft, Lugar Certo e Casa Mineira
// (0 anúncios na região nas medições) só rodam com { amplo: true } / SSJB_AMPLO=1.
// KNOWN_LINKS_FILE (ver scrapers/known.js): anúncio já conhecido com o mesmo preço não tem o detalhe aberto.
// As fontes rodam em paralelo (fetch puro + um Chromium com um contexto por site).
const fs = require('fs');
const path = require('path');
const { passaFiltro } = require('./common');
const { reaproveitar, conhecido, CAMPOS: CAMPOS_CONHECIDOS } = require('./known');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TERMINAL_SS = { lat: -15.9133454, lon: -47.7573464 };
const SS = 'São Sebastião';
const JB = 'Jardim Botânico';

// ------------------------------------------------------------------ utilidades
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[ss_jb ${new Date().toISOString().slice(11, 19)}]`, ...a);
const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);
const iso = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10); };

function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[^\d,.-]/g, '');
  if (!s) return null;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/\.(?=\d{3}(\D|$))/g, ''));
  return Number.isFinite(n) ? n : null;
}
const pos = (v) => { const n = num(v); return n && n > 0 ? n : null; };
const coord = (v) => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; };

function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const kmTerminal = (lat, lon) => (lat != null && lon != null ? distKm(lat, lon, TERMINAL_SS.lat, TERMINAL_SS.lon) : null);

function dataRelativa(txt, hoje = new Date()) {
  if (!txt) return null;
  const t = norm(txt);
  const d = new Date(hoje);
  if (/\bhoje\b/.test(t)) return iso(d);
  if (/\bontem\b/.test(t)) { d.setDate(d.getDate() - 1); return iso(d); }
  let m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/(\d+|um|uma)\s*(minuto|hora|dia|semana|mes|ano)/);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  if (m[2] === 'dia') d.setDate(d.getDate() - n);
  else if (m[2] === 'semana') d.setDate(d.getDate() - 7 * n);
  else if (m[2] === 'mes') d.setMonth(d.getMonth() - n);
  else if (m[2] === 'ano') d.setFullYear(d.getFullYear() - n);
  return iso(d);
}

async function getText(url, headers = {}, tentativas = 3) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9', ...headers }, signal: AbortSignal.timeout(40000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      if (i === tentativas) throw e;
      await sleep(1500 * i);
    }
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch (e) { log('erro item:', e.message); } }
  }));
}

function extrairJSON(s, inicio) {
  const i0 = s.indexOf('{', inicio);
  if (i0 < 0) return null;
  let prof = 0, str = false, esc = false;
  for (let i = i0; i < s.length; i++) {
    const c = s[i];
    if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '{') prof++;
    else if (c === '}') { prof--; if (prof === 0) { try { return JSON.parse(s.slice(i0, i + 1)); } catch { return null; } } }
  }
  return null;
}

// ------------------------------------------------------------------ região
const RE_JB = /jardim botanico|mangueiral|toror[o]|altiplano leste/;
const RE_SS = /sao sebastiao|morro azul|crixa|joao candido|vila do boa|residencial do bosque|nova sao sebastiao/;
const RE_BARTOLOMEU = /sao bartolomeu/;
// Bairros com nome genérico (existem em outras RAs): só valem com contexto (busca específica, texto ou geo).
const RE_SS_AMBIG = /\b(centro|bela vista|vila nova|tradicional|sao jose|setor residencial oeste|residencial oeste|bosque|bonsucesso|vitoria|sao francisco)\b/;

/**
 * Classifica a região a partir do texto de localização (bairro/cidade/endereço), das coordenadas
 * e de uma "dica" (região da busca por localidade que retornou o anúncio).
 * Retorna 'São Sebastião' | 'Jardim Botânico' | null.
 */
function classificar({ local = '', titulo = '', lat = null, lon = null, geoConfiavel = true, dica = null }) {
  const t = norm(local);
  const km = geoConfiavel ? kmTerminal(lat, lon) : null;
  // geo muito longe (>18 km do terminal de SS) -> não é SS/JB, a menos que seja geo aproximado
  if (km != null && km > 18) return null;
  if (RE_JB.test(t)) return JB;
  if (RE_SS.test(t)) return SS;
  if (RE_BARTOLOMEU.test(t)) return JB;
  if (dica && RE_SS_AMBIG.test(t) && dica === SS) return SS;
  if (km != null && km <= 4) return SS;
  if (dica && (km == null || km <= 12)) return dica;
  // último recurso: título (ex.: "Casa em São Sebastião")
  const tt = norm(titulo);
  if (km != null || !geoConfiavel) {
    if (/mangueiral|jardim botanico|toror/.test(tt)) return JB;
    if (/sao sebastiao/.test(tt)) return SS;
  }
  return null;
}

// Exclusões extras além do passaFiltro: kitnet/studio/quitinete/quarto avulso/sala comercial/temporada.
const RE_EXCLUI_TITULO = /kit ?net|kitinete|quitinete|kitchenette|\bstudio\b|\best[uú]dio\b|conjugad|quarto (avulso|individual|mobiliado para|para (estudante|rapaz|moça|mo[cç]a|solteir))|aluga-se (um )?quarto|sala comercial|ponto comercial|im[oó]vel comercial|\(comercial\)|\btemporada\b|\bdi[aá]ria\b/i;
const RE_EXCLUI_TIPO = /kit ?net|kitinete|quitinete|kitchenette|studio|est[uú]dio|conjugad|quarto|vaga|sala|comercial|loja|galp[aã]o|terreno|lote|pr[eé]dio|ponto|temporada|flat/i;
function excluido(a) {
  return RE_EXCLUI_TIPO.test(a.tipo || '') || RE_EXCLUI_TITULO.test(a.titulo || '');
}

function registro(o) {
  const a = {
    site: o.site, titulo: o.titulo || null, tipo: o.tipo || null, regiao: o.regiao || null,
    bairro: o.bairro || null, endereco: o.endereco || null, cep: o.cep ? String(o.cep).replace(/\D/g, '').replace(/^(\d{5})(\d{3})$/, '$1-$2') || null : null,
    lat: o.lat ?? null, lon: o.lon ?? null,
    preco: o.preco ?? null, condominio: o.condominio ?? null, iptu: o.iptu ?? null,
    area_m2: o.area_m2 ?? null, quartos: o.quartos ?? null, banheiros: o.banheiros ?? null, vagas: o.vagas ?? null,
    data_publicacao: o.data_publicacao || null, data_tipo: o.data_tipo || null,
    link: o.link, id_site: o.id_site != null ? String(o.id_site) : null,
    coletado_em: new Date().toISOString(),
  };
  if (o.link_vivareal) a.link_vivareal = o.link_vivareal;
  if (o.geo_aprox) a.geo_aprox = true;
  return a;
}

async function novoBrowser() {
  const { chromium } = require('playwright');
  return chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
}
async function novoContexto(browser, bloquearMidia = true) {
  const ctx = await browser.newContext({
    userAgent: UA, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  if (bloquearMidia) await ctx.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  return ctx;
}

// ------------------------------------------------------------------ ZAP + VivaReal (glue-api)
const GLUE_LOCAIS = [
  { dica: SS, p: { addressLocationId: 'BR>Distrito Federal>NULL>Sao Sebastiao', addressType: 'city', addressState: 'Distrito Federal', addressCity: 'São Sebastião' } },
  ...[
    ['Sao Sebastiao', SS], ['Centro Sao Sebastiao', SS], ['Area Rural de Sao Sebastiao', SS],
    ['Vila Sao Jose', null], ['Setor Residencial Oeste', null], ['Setor Tradicional', null], ['Morro Azul', SS],
    ['Jardins Mangueiral', JB], ['Setor Habitacional Jardim Botanico', JB], ['Jardim Botanico', JB],
    ['Setor Habitacional Tororo', JB], ['Setor Habitacional Sao Bartolomeu', JB], ['Mangueiral', JB],
  ].map(([b, dica]) => ({ dica, p: { addressLocationId: `BR>Distrito Federal>NULL>Brasilia>Barrios>${b}`, addressType: 'neighborhood' } })),
  // varredura do DF inteiro (pega anúncios com localidade cadastrada de forma diferente)
  { dica: null, p: { addressLocationId: 'BR>Distrito Federal', addressType: 'state', addressState: 'Distrito Federal' } },
];
const GLUE_INCLUDE = 'search(result(listings(listing(createdAt,updatedAt,title,id,address,bedrooms,bathrooms,' +
  'parkingSpaces,usableAreas,totalAreas,pricingInfos,unitTypes,usageTypes,description),link(href))),totalCount)';
const GLUE_TIPOS = { APARTMENT: 'Apartamento', HOME: 'Casa', CONDOMINIUM: 'Casa de condomínio' };

async function glueSite(browser, site, precoMax) {
  const ctx = await novoContexto(browser, false);
  const page = await ctx.newPage();
  const porId = new Map(); // id -> {item, dica}
  let bloqueio = null;
  try {
    const resp = await page.goto(site.home, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const title = await page.title();
    if (!resp || resp.status() >= 400 || /attention required|just a moment/i.test(title)) bloqueio = `home ${resp && resp.status()} "${title}"`;
    await page.waitForTimeout(1500 + Math.random() * 750); // pausas pela metade: sem rate-limit observado
    for (const loc of GLUE_LOCAIS) {
      for (let pg = 0; pg < 15; pg++) {
        const q = new URLSearchParams({
          business: 'RENTAL', parentId: 'null', listingType: 'USED', categoryPage: 'RESULT',
          unitTypes: 'APARTMENT,HOME,CONDOMINIUM', unitTypesV3: 'APARTMENT,HOME,CONDOMINIUM', usageTypes: 'RESIDENTIAL,RESIDENTIAL,RESIDENTIAL',
          addressCountry: 'Brasil', ...loc.p, priceMax: String(precoMax), size: '30', from: String(pg * 30), page: String(pg + 1),
        });
        const url = `${site.api}?${q}&includeFields=${encodeURIComponent(GLUE_INCLUDE)}`;
        const r = await page.evaluate(async ([u, dom]) => {
          try { const res = await fetch(u, { headers: { 'x-domain': dom } }); return { s: res.status, t: await res.text() }; } catch (e) { return { s: 0, t: String(e) }; }
        }, [url, site.domain]);
        if (r.s !== 200) { bloqueio = `API ${r.s} em ${loc.p.addressLocationId}: ${r.t.slice(0, 80)}`; break; }
        const j = JSON.parse(r.t);
        const L = j.search?.result?.listings || [];
        for (const it of L) {
          const id = it.listing?.id;
          if (!id) continue;
          const prev = porId.get(id);
          if (!prev) porId.set(id, { it, dica: loc.dica });
          else if (!prev.dica && loc.dica) prev.dica = loc.dica;
        }
        const total = j.search?.totalCount || 0;
        if (L.length < 30 || (pg + 1) * 30 >= total) break;
        await page.waitForTimeout(400 + Math.random() * 400);
      }
      await page.waitForTimeout(250 + Math.random() * 300);
    }
  } catch (e) { bloqueio = `erro: ${e.message}`; }
  finally { await ctx.close(); }
  log(`${site.nome}: ${porId.size} anúncios brutos (localidades + DF)${bloqueio ? ' | BLOQUEIO: ' + bloqueio : ''}`);
  return { porId, bloqueio };
}

function glueMapear(it, dica, site) {
  const l = it.listing || {};
  const a = l.address || {};
  const pr = (l.pricingInfos || []).find((x) => x.businessType === 'RENTAL') || first(l.pricingInfos) || {};
  const pt = a.point || {};
  const aprox = !!pt.aproximated || pt.lat == null;
  let lat = coord(pt.lat ?? pt.approximateLat), lon = coord(pt.lon ?? pt.approximateLon);
  // ponto "PUBLISHER" no centro de Brasília é placeholder
  if (lat != null && Math.abs(lat - -15.826691) < 1e-4 && Math.abs(lon - -47.92182) < 1e-4) { lat = null; lon = null; }
  const locId = a.locationId || '';
  const cidadeLoc = (locId.split('>')[3] || '').replace(/Sao Sebastiao/, 'São Sebastião');
  const bairro = a.neighborhood || locId.split('>').pop() || null;
  const endereco = [a.street, a.streetNumber, a.complement, bairro, cidadeLoc && cidadeLoc !== 'Brasilia' ? cidadeLoc : a.city, 'DF'].filter(Boolean).join(', ');
  const local = [locId.replace(/>/g, ' '), bairro, a.city, a.street, a.complement].join(' | ');
  const km = kmTerminal(lat, lon);
  // geo aproximado e muito longe -> descarta o ponto (geocodificação ruim do portal)
  if (aprox && km != null && km > 18) { lat = null; lon = null; }
  const regiao = classificar({ local, titulo: l.title, lat, lon, geoConfiavel: !aprox, dica });
  let link = it.link?.href ? new URL(it.link.href, site.base).toString().split('?')[0] : `${site.base}/imovel/id-${l.id}/`;
  const created = iso(l.createdAt), updated = iso(l.updatedAt);
  return registro({
    site: site.nome, titulo: l.title, tipo: GLUE_TIPOS[first(l.unitTypes)] || first(l.unitTypes), regiao, bairro, endereco,
    cep: a.zipCode, lat, lon, geo_aprox: lat != null && aprox,
    preco: num(pr.price), condominio: pos(pr.monthlyCondoFee), iptu: pos(pr.iptu) ?? pos(pr.yearlyIptu),
    area_m2: pos(first(l.usableAreas)) ?? pos(first(l.totalAreas)),
    quartos: num(first(l.bedrooms)), banheiros: num(first(l.bathrooms)), vagas: num(first(l.parkingSpaces)),
    data_publicacao: created || updated, data_tipo: created ? 'publicado' : updated ? 'atualizado' : null,
    link, id_site: l.id,
  });
}

async function zapVivaReal(browser, precoMax, stats) {
  const SITES = [
    { nome: 'ZAP', home: 'https://www.zapimoveis.com.br/aluguel/imoveis/df+brasilia/', api: 'https://glue-api.zapimoveis.com.br/v2/listings', domain: '.zapimoveis.com.br', base: 'https://www.zapimoveis.com.br' },
    { nome: 'VivaReal', home: 'https://www.vivareal.com.br/aluguel/distrito-federal/brasilia/', api: 'https://glue-api.vivareal.com/v2/listings', domain: '.vivareal.com.br', base: 'https://www.vivareal.com.br' },
  ];
  const res = {};
  await Promise.all(SITES.map(async (s) => { // sites diferentes: em paralelo
    const { porId, bloqueio } = await glueSite(browser, s, precoMax);
    res[s.nome] = new Map([...porId].map(([id, { it, dica }]) => [id, glueMapear(it, dica, s)]));
    stats[s.nome] = { brutos: porId.size, bloqueio };
  }));
  // Mesmo estoque: registro principal do ZAP + link do VivaReal (mesmo id de anúncio)
  const out = [];
  for (const [id, a] of res.ZAP) {
    const v = res.VivaReal.get(id);
    if (v) { a.link_vivareal = v.link; if (!a.regiao) a.regiao = v.regiao; }
    out.push(a);
  }
  for (const [id, v] of res.VivaReal) if (!res.ZAP.has(id)) out.push(v);
  return out;
}

// ------------------------------------------------------------------ QuintoAndar
async function quintoAndar(precoMax, stats) {
  const API = 'https://apigw.prod.quintoandar.com.br/house-listing-search/v2/search/list';
  const FIELDS = ['id', 'type', 'rent', 'totalCost', 'condominium', 'iptu', 'area', 'bedrooms', 'bathrooms', 'parkingSpaces',
    'address', 'neighbourhood', 'city', 'regionName', 'shortRentDescription', 'location'];
  // Viewport cobrindo São Sebastião + Jardim Botânico + Mangueiral + Tororó
  const VP = { lat: -15.89, lng: -47.80, north: -15.80, south: -16.02, east: -47.66, west: -47.93 };
  const H = { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://www.quintoandar.com.br', Referer: 'https://www.quintoandar.com.br/' };
  const brutos = [];
  let offset = 0, total = Infinity, bloqueio = null;
  while (offset < total && offset < 1000) {
    const p = new URLSearchParams({
      'context.listShowing': 'true', 'context.numPhotos': '0', 'context.isSSR': 'false', 'filters.businessContext': 'RENT',
      'filters.location.coordinate.lat': VP.lat, 'filters.location.coordinate.lng': VP.lng,
      'filters.location.viewport.east': VP.east, 'filters.location.viewport.north': VP.north,
      'filters.location.viewport.south': VP.south, 'filters.location.viewport.west': VP.west, 'filters.location.countryCode': 'BR',
      'filters.priceRange[0].costType': 'RENT_PRICE', 'filters.priceRange[0].range.min': '0', 'filters.priceRange[0].range.max': String(precoMax),
      'filters.availability': 'ANY', 'filters.occupancy': 'ANY', 'pagination.pageSize': '50', 'pagination.offset': String(offset),
    });
    FIELDS.forEach((f, i) => p.append(`fields[${i}]`, f));
    let j = null;
    try { j = JSON.parse(await getText(`${API}?${p}`, H)); } catch (e) { bloqueio = e.message; break; }
    total = j.hits?.total?.value || 0;
    const hits = j.hits?.hits || [];
    if (!hits.length) break;
    brutos.push(...hits.map((h) => h._source));
    offset += hits.length;
    await sleep(400);
  }
  stats.QuintoAndar = { brutos: brutos.length, bloqueio };
  log(`QuintoAndar: ${brutos.length} anúncios brutos no viewport SS/JB`);
  const out = [];
  for (const s of brutos) {
    const lat = coord(s.location?.lat), lon = coord(s.location?.lon ?? s.location?.lng);
    const local = [s.neighbourhood, s.address, s.city].filter(Boolean).join(' | ');
    let regiao = classificar({ local, lat, lon });
    if (!regiao && /sao sebastiao|jardim botanico/.test(norm(s.regionName)) && kmTerminal(lat, lon) <= 12) regiao = /botanico/.test(norm(s.regionName)) ? JB : SS;
    out.push(registro({
      site: 'QuintoAndar', titulo: s.shortRentDescription || `${s.type || 'Imóvel'} para alugar em ${s.neighbourhood || ''}`,
      tipo: s.type, regiao, bairro: s.neighbourhood, endereco: [s.address, s.neighbourhood, s.city, 'DF'].filter(Boolean).join(', '),
      lat, lon, preco: num(s.rent), condominio: pos(s.condominium), iptu: pos(s.iptu), area_m2: pos(s.area),
      quartos: num(s.bedrooms), banheiros: num(s.bathrooms), vagas: num(s.parkingSpaces),
      link: `https://www.quintoandar.com.br/imovel/${s.id}`, id_site: s.id,
    }));
  }
  return out;
}
async function quintoAndarDetalhe(a) {
  try {
    const html = await getText(a.link);
    const m = html.match(/"businessContext":"RENT","status":"[^"]*","firstPublicationDate":"([^"]+)","lastPublicationDate":"([^"]+)"/)
      || html.match(/"firstPublicationDate":"([^"]+)"[^}]*?"lastPublicationDate":"([^"]+)"/);
    if (m) { a.data_publicacao = iso(m[1]); a.data_tipo = 'publicado'; }
    else { const lp = html.match(/"lastPublishedDate":"([^"]+)"/); if (lp) { a.data_publicacao = iso(lp[1]); a.data_tipo = 'atualizado'; } }
    const cep = html.match(/"(?:zipCode|postalCode)":"(\d{5}-?\d{3})"/);
    if (cep && !a.cep) a.cep = cep[1].replace(/^(\d{5})(\d{3})$/, '$1-$2');
  } catch (e) { log('QuintoAndar detalhe falhou', a.link, e.message); }
}

// ------------------------------------------------------------------ Chaves na Mão
const CHAVES_SLUGS = [
  ['sao-sebastiao', SS], ['centro-sao-sebastiao', SS], ['area-rural-de-sao-sebastiao', SS], ['setor-residencial-oeste-sao-sebastiao', SS],
  ['vila-nova-sao-sebastiao', SS], ['bela-vista-sao-sebastiao', SS], ['morro-azul-sao-sebastiao', SS], ['setor-tradicional-sao-sebastiao', SS],
  ['vila-sao-jose-sao-sebastiao', SS], ['residencial-do-bosque-sao-sebastiao', SS], ['joao-candido-sao-sebastiao', SS], ['crixa-sao-sebastiao', SS],
  ['vila-do-boa-sao-sebastiao', SS], ['residencial-vitoria-sao-sebastiao', SS], ['bonsucesso-sao-sebastiao', SS], ['sao-francisco-sao-sebastiao', SS],
  ['sao-bartolomeu-sao-sebastiao', SS], ['jardins-mangueiral-sao-sebastiao', JB], ['jardins-mangueiral', JB],
  ['setor-habitacional-jardim-botanico', JB], ['jardim-botanico-lago-sul', JB], ['setor-habitacional-tororo', JB],
];
async function chavesNaMao(browser, precoMax, stats) {
  const SITE = 'Chaves na Mão';
  const ctx = await novoContexto(browser);
  const page = await ctx.newPage();
  const vistos = new Map(); // url -> {o, dica}
  const buscas = [
    ...CHAVES_SLUGS.map(([s, dica]) => ({ base: `https://www.chavesnamao.com.br/imoveis-para-alugar/df-brasilia/${s}/`, dica })),
    { base: 'https://www.chavesnamao.com.br/imoveis-para-alugar/df-sao-sebastiao/', dica: SS },
    { base: 'https://www.chavesnamao.com.br/imoveis-para-alugar/df/', dica: null, max: 25 }, // varredura DF
  ];
  let bloqueio = null;
  for (const b of buscas) {
    for (let pg = 1; pg <= (b.max || 5); pg++) {
      const url = `${b.base}?filtro=pmax:${precoMax}${pg > 1 ? '&pg=' + pg : ''}`;
      let offers = [];
      try {
        let r = null;
        for (let t = 0; t < 2 && !r; t++) r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
        if (!r) break; // ERR_ABORTED (página sem resultados / redirecionamento) -> segue para a próxima busca
        if (r.status() >= 400) { bloqueio = `HTTP ${r.status()} em ${url}`; break; }
        // Bairro sem estoque mostra "0 Imóveis..." e sugestões de outros lugares -> ignora
        const h1 = await page.$eval('h1', (e) => e.innerText).catch(() => '');
        if (/^\s*0\s+im/i.test(h1)) break;
        const mh = h1.match(/^\s*([\d.]+)\s+im/i);
        if (mh) b.total = Number(mh[1].replace(/\./g, ''));
        const lds = await page.$$eval('script[type="application/ld+json"]', (s) => s.map((x) => x.textContent));
        for (const s of lds) { try { const j = JSON.parse(s); if (j.offers?.itemListElement) offers = j.offers.itemListElement; } catch {} }
      } catch (e) { bloqueio = e.message; break; }
      // Depois dos resultados reais a página lista "sugestões" de outros locais -> corta pelo total do título
      if (b.total != null) { offers = offers.slice(0, Math.max(0, b.total - (b.lidos || 0))); b.lidos = (b.lidos || 0) + offers.length; }
      let novos = 0;
      for (const o of offers) {
        if (!o.url) continue;
        const prev = vistos.get(o.url);
        if (!prev) { vistos.set(o.url, { o, dica: b.dica }); novos++; } else if (!prev.dica && b.dica) prev.dica = b.dica;
      }
      if (!offers.length || !novos) break;
      await sleep(600);
    }
  }
  stats[SITE] = { brutos: vistos.size, bloqueio };
  log(`${SITE}: ${vistos.size} anúncios brutos (bairros + DF)`);
  const out = [];
  for (const [link, { o, dica }] of vistos) {
    const it = o.itemOffered || {};
    const ad = it.address || {};
    const slugTipo = (link.match(/\/imovel\/([a-z-]+?)-para-alugar/) || [])[1] || '';
    const lat = coord(it.geo?.latitude), lon = coord(it.geo?.longitude);
    const bairro = ad.addressLocality || null;
    const local = [bairro, ad.streetAddress, ad.addressRegion, link.split('/imovel/')[1]].join(' | ');
    out.push(registro({
      site: SITE, titulo: o.name, tipo: slugTipo.replace(/-/g, ' '), regiao: classificar({ local, titulo: o.name, lat, lon, dica }),
      bairro, endereco: [String(ad.streetAddress || '').replace(/,\s*$/, ''), bairro, ad.addressRegion].filter(Boolean).join(', '),
      cep: ad.postalCode, lat, lon, preco: num(o.price), area_m2: num(it.floorSize?.value ?? it.floorSize?.unitText),
      quartos: it.numberOfBedrooms ?? null, banheiros: it.numberOfBathroomsTotal ?? null,
      link, id_site: (link.match(/id-(\d+)/) || [])[1],
    }));
  }
  return { itens: out, ctx };
}
async function chavesDetalhe(ctx, a) {
  const p = await ctx.newPage();
  try {
    await p.goto(a.link, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const d = await p.evaluate(() => {
      let pub = null, mod = null, geo = null, cep = null, rua = null;
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const j = JSON.parse(s.textContent);
          for (const n of j['@graph'] || [j]) {
            pub = pub || n.datePosted || n.datePublished || null;
            mod = mod || n.dateModified || null;
            const io = n.itemOffered || n.offers?.itemOffered || n;
            if (io?.geo && !geo) geo = io.geo;
            if (io?.address?.postalCode && !cep) cep = io.address.postalCode;
            if (io?.address?.streetAddress && !rua) rua = io.address.streetAddress;
          }
        } catch {}
      }
      return { txt: document.body.innerText.replace(/\s+/g, ' ').slice(0, 20000), pub, mod, geo, cep, rua };
    });
    const g = (re) => { const m = d.txt.match(re); return m ? m[1] : null; };
    a.condominio = pos(g(/Condom[ií]nio\s*R\$\s*([\d.,]+)/i));
    a.iptu = pos(g(/IPTU\s*R\$\s*([\d.,]+)/i));
    const ar = g(/[ÁA]rea [úu]til\s*([\d.,]+)\s*m/i) || g(/[ÁA]rea total\s*([\d.,]+)\s*m/i); if (ar) a.area_m2 = num(ar);
    const ban = g(/Banheiros?\s*(\d+)/i); if (ban) a.banheiros = Number(ban);
    const qua = g(/Quartos?\s*(\d+)/i); if (qua) a.quartos = Number(qua);
    const gar = g(/Garage(?:ns|m)\s*(\d+|--)/i); a.vagas = gar && gar !== '--' ? Number(gar) : gar === '--' ? 0 : null;
    if (d.cep && !a.cep) a.cep = String(d.cep).replace(/\D/g, '').replace(/^(\d{5})(\d{3})$/, '$1-$2') || null;
    if (d.geo && a.lat == null) { a.lat = coord(d.geo.latitude); a.lon = coord(d.geo.longitude); }
    if (d.rua && (!a.endereco || a.endereco.length < String(d.rua).length)) a.endereco = [String(d.rua).replace(/,\s*$/, ''), a.bairro].filter(Boolean).join(', ');
    if (d.pub) { a.data_publicacao = iso(d.pub); a.data_tipo = 'publicado'; }
    else if (d.mod) { a.data_publicacao = iso(d.mod); a.data_tipo = 'atualizado'; }
    else { const at = g(/[ÚU]ltima atualiza[çc][ãa]o:\s*(\d{2}\/\d{2}\/\d{4})/i); if (at) { a.data_publicacao = dataRelativa(at); a.data_tipo = 'atualizado'; } }
  } catch (e) { log('Chaves detalhe falhou', a.link, e.message); }
  finally { await p.close(); }
}

// ------------------------------------------------------------------ Loft
async function loft(precoMax, stats, amplo = false) {
  const SITE = 'Loft';
  const api = 'https://landscape-api.loft.com.br/listing/v2/search';
  const H = { 'x-origin': 'http://loft-website-sales.loft.com.br', Accept: 'application/json', Origin: 'https://loft.com.br', Referer: 'https://loft.com.br/' };
  const BAIRROS = [
    ['setor habitacional jardim botanico', JB], ['jardim botanico', JB], ['jardins mangueiral', JB], ['setor habitacional tororo', JB],
    ['setor habitacional sao bartolomeu', JB], ['sao sebastiao', SS], ['centro (sao sebastiao)', SS], ['setor residencial oeste (sao sebastiao)', SS],
    ['vila nova (sao sebastiao)', SS], ['morro azul', SS],
  ];
  const brutos = new Map(); // id -> {l, dica}
  let bloqueio = null;
  const add = (ls, dica) => { for (const l of ls) { const p = brutos.get(l.id); if (!p) brutos.set(l.id, { l, dica }); else if (!p.dica && dica) p.dica = dica; } };
  try {
    // 1) busca por bairro (neighborhood[] aceita até 10); uma chamada por bairro p/ saber a dica
    for (const [b, dica] of BAIRROS) {
      for (let p = 0; p < 5; p++) {
        const qs = `neighborhood%5B%5D=${encodeURIComponent(b + ', brasilia, df')}&transactionType%5B%5D=for_rent&orderBy%5B%5D=priceOfSale&hitsPerPage=38${p ? '&page=' + p : ''}`;
        const d = JSON.parse(await getText(`${api}?${qs}`, H));
        const ls = d.listings || [];
        add(ls.filter((l) => l.rentalPrice <= precoMax), dica);
        if (!ls.length || ls[ls.length - 1].rentalPrice > precoMax || p + 1 >= (d.pagination?.totalPages || 0)) break;
      }
      await sleep(250);
    }
    // 2) (só com amplo) varredura do DF ordenada por aluguel crescente até passar do teto
    for (let p = 0; amplo && p < 30; p++) {
      const qs = `orderBy%5B%5D=priceOfSale&cities%5B%5D=brasilia%2C+df&transactionType%5B%5D=for_rent&hitsPerPage=38${p ? '&page=' + p : ''}`;
      const d = JSON.parse(await getText(`${api}?${qs}`, H));
      const ls = d.listings || [];
      add(ls.filter((l) => l.rentalPrice <= precoMax), null);
      if (!ls.length || ls[ls.length - 1].rentalPrice > precoMax || p + 1 >= (d.pagination?.totalPages || 0)) break;
      await sleep(300);
    }
  } catch (e) { bloqueio = e.message; }
  stats[SITE] = { brutos: brutos.size, bloqueio };
  log(`${SITE}: ${brutos.size} anúncios brutos <= R$${precoMax} (bairros${amplo ? ' + DF' : ''})`);
  const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const out = [];
  for (const { l, dica } of brutos.values()) {
    if (l.rentalPeriod && l.rentalPeriod !== 'MONTHLY') continue;
    if (l.usageType && l.usageType !== 'residential') continue;
    if (!/apartment|house/i.test(l.homeType || '')) continue;
    const a = l.address || {};
    const tipoBase = /house/i.test(l.homeType) ? (/condo/i.test(l.propertyType || '') ? 'Casa de condomínio' : 'Casa') : 'Apartamento';
    const tipo = tipoBase + (/studio/i.test(l.propertyType || '') ? ' (Studio)' : /conjugate/i.test(l.propertyType || '') ? ' (Conjugado)' : '');
    const q = l.bedrooms;
    const lat = coord(l._geoloc?.lat ?? l.location?.lat), lon = coord(l._geoloc?.lng ?? l.location?.lng);
    const rua = a.streetFullName || a.streetName;
    const linkSlug = slug([tipoBase === 'Apartamento' ? 'Apartamento' : 'Casa', a.streetName, a.neighborhood, a.city, q != null ? `${q}-quarto${q === 1 ? '' : 's'}` : '', l.area ? `${l.area}m2` : ''].join(' '));
    out.push(registro({
      site: SITE,
      titulo: `${tipo} ${q != null ? q + (q === 1 ? ' quarto' : ' quartos') : ''} ${l.area ? l.area + 'm²' : ''} - ${rua || ''}, ${a.neighborhood || ''}`.replace(/\s+/g, ' ').trim(),
      tipo, regiao: classificar({ local: [a.neighborhood, rua, a.complexName].join(' | '), lat, lon, dica }),
      bairro: a.neighborhood, endereco: [rua, a.number, a.complexName, a.neighborhood, a.city, a.state].filter(Boolean).join(', '),
      cep: a.postalCode, lat, lon, preco: l.rentalPrice, condominio: pos(l.complexFee), iptu: pos(l.propertyTax),
      area_m2: pos(l.area), quartos: l.bedrooms ?? null, banheiros: l.restrooms ?? null, vagas: l.parkingSpots ?? null,
      data_publicacao: iso(l.createdAt), data_tipo: l.createdAt ? 'publicado' : null,
      link: `https://loft.com.br/imovel/${linkSlug}/${l.id}?tipoTransacao=aluguel`, id_site: l.id,
    }));
  }
  return out;
}

// ------------------------------------------------------------------ Lugar Certo
async function lugarCerto(precoMax, stats, amplo = false) {
  const SITE = 'Lugar Certo';
  const base = 'https://correiobraziliense.lugarcerto.com.br/busca/aluguel/df';
  const brutos = new Map();
  let bloqueio = null;
  // A busca por localidade (/df/sao-sebastiao) devolve resultados de todo o DF quando não há estoque local,
  // então (só com amplo) varremos o DF inteiro (~300 anúncios) e filtramos por bairro/cidade/coordenada.
  // Sem amplo: só /sao-sebastiao (até 5 páginas) e só abre o detalhe de anúncios cujo texto cita SS/JB.
  const bases = amplo ? [`${base}/sao-sebastiao`, base] : [`${base}/sao-sebastiao`];
  try {
    for (const b of bases) {
      let totalPag = null;
      for (let p = 0; p < (amplo ? 25 : 5); p++) {
        const html = await getText(p ? `${b}?offset=${p * 20}` : b);
        const re = /window\.dados_anuncios\["(\d+)"\]=/g;
        let m, n = 0;
        while ((m = re.exec(html))) { const d = extrairJSON(html, m.index + m[0].length); if (d && !brutos.has(d.idanuncio)) { brutos.set(d.idanuncio, d); n++; } }
        const tp = html.match(/max="(\d+)"[^>]*value="\d+"[^>]*>\s*<input[^>]*>\s*de (\d+)/);
        if (tp) totalPag = Number(tp[2]);
        if (!n || (totalPag && p + 1 >= totalPag)) break;
        await sleep(300);
      }
    }
  } catch (e) { bloqueio = e.message; }
  stats[SITE] = { brutos: brutos.size, bloqueio };
  log(`${SITE}: ${brutos.size} anúncios brutos (${amplo ? 'DF' : 'São Sebastião'})`);
  const cands = [...brutos.values()].filter((d) => {
    const p = num(d.preco);
    if (!(p && p <= precoMax)) return false;
    if (amplo) return true;
    const t = norm([d.bairro, d.local, d.endereco].join(' | '));
    return RE_SS.test(t) || RE_JB.test(t) || RE_BARTOLOMEU.test(t);
  });
  const out = [];
  await pool(cands, 4, async (d) => {
    const link = 'https:' + d.urldestino.replace(/^https?:/, '');
    let det = {};
    const k = conhecido({ link, preco: num(d.preco) });
    if (k) { // já conhecido com o mesmo preço: sem detalhe
      reaproveitar.total = (reaproveitar.total || 0) + 1;
      const regiao = classificar({ local: [d.bairro, d.local, d.endereco].join(' | '), lat: k.lat, lon: k.lon });
      if (!regiao) return;
      const o = {};
      for (const c of [...CAMPOS_CONHECIDOS, 'titulo', 'tipo']) if (k[c] != null) o[c] = k[c]; // titulo/tipo: opcionais
      out.push(registro({
        site: SITE, titulo: d.descricaoanuncio, tipo: (d.descricaoanuncio || '').split(',')[0].trim(), regiao, bairro: d.bairro,
        endereco: [d.endereco, d.bairro, d.local].filter(Boolean).join(', '), preco: num(d.preco), area_m2: pos(d.area),
        quartos: d.numquartos ?? null, banheiros: d.numbanheiros ?? null, vagas: d.numvagas ?? null, link, id_site: d.idanuncio, ...o,
      }));
      return;
    }
    try { const html = await getText(link); const i = html.indexOf('window.detalheanuncio='); if (i >= 0) det = extrairJSON(html, i) || {}; } catch (e) { log(`${SITE} detalhe falhou ${link}: ${e.message}`); }
    const lat = coord(det.dc_lat), lon = coord(det.dc_lng);
    const local = [d.bairro, d.local, d.endereco, det.us_bairro, det.sc_cidade].join(' | ');
    const regiao = classificar({ local, lat, lon });
    if (!regiao) return;
    const tipo = det.sc_tipoimovel || (d.descricaoanuncio || '').split(',')[0].trim();
    const dtIns = det.dt_insercao, dtAt = det.dt_atualizacao || det.dt_alteracao;
    out.push(registro({
      site: SITE, titulo: det.sc_titulodescricao || d.descricaoanuncio, tipo: det.sc_grupo === 'Comerciais' ? `${tipo} (comercial)` : tipo, regiao,
      bairro: d.bairro, endereco: [d.endereco || det.us_endereco, d.bairro, d.local].filter(Boolean).join(', '), cep: det.sc_cep,
      lat, lon, preco: num(d.preco), condominio: pos(det.dc_precocondominio ?? det.dc_condominio), iptu: pos(det.dc_iptu),
      area_m2: pos(d.area ?? det.ia_areaconstruida ?? det.ia_areautil ?? det.ia_areatotal),
      quartos: d.numquartos ?? det.ia_quarto ?? null, banheiros: d.numbanheiros ?? det.ia_banheiro ?? null, vagas: d.numvagas ?? det.ia_vaga ?? null,
      data_publicacao: iso(dtIns || dtAt), data_tipo: dtIns ? 'publicado' : dtAt ? 'atualizado' : null,
      link, id_site: d.idanuncio,
    }));
  });
  return out;
}

// ------------------------------------------------------------------ Casa Mineira
async function casaMineira(browser, precoMax, stats) {
  const SITE = 'Casa Mineira';
  const ctx = await novoContexto(browser);
  const page = await ctx.newPage();
  const brutos = new Map();
  let bloqueio = null;
  // A plataforma redireciona slugs de bairro inexistentes para /df; o estoque do DF é pequeno (~250), então varremos tudo.
  for (const tipoUrl of ['apartamento', 'casa']) {
    for (let p = 1; p <= 20; p++) {
      const url = `https://www.casamineira.com.br/aluguel/${tipoUrl}/df${p > 1 ? '/pagina-' + p : ''}`;
      try {
        const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (r && r.status() >= 400) { bloqueio = `HTTP ${r.status()}`; break; }
        await page.waitForSelector('[data-qa="POSTING_CARD_PRICE"]', { timeout: 20000 }).catch(() => {});
      } catch (e) { bloqueio = e.message; break; }
      const cards = await page.evaluate(() => [...document.querySelectorAll('[data-to-posting][data-id]')].map((c) => ({
        id: c.dataset.id, href: c.dataset.toPosting,
        preco: c.querySelector('[data-qa="POSTING_CARD_PRICE"]')?.innerText || '',
        exp: c.querySelector('[data-qa="expensas"]')?.innerText || '',
        feats: [...c.querySelectorAll('[data-qa="POSTING_CARD_FEATURES"] span')].map((s) => s.innerText),
        end: c.querySelector('[class*="location-address"]')?.innerText || '',
        loc: c.querySelector('[data-qa="POSTING_CARD_LOCATION"]')?.innerText || '',
        desc: c.querySelector('[data-qa="POSTING_CARD_DESCRIPTION"]')?.innerText || '',
      })));
      let novos = 0;
      for (const c of cards) if (!brutos.has(c.id)) { brutos.set(c.id, { ...c, tipoUrl }); novos++; }
      if (!novos || cards.length < 20) break;
      await sleep(700);
    }
  }
  stats[SITE] = { brutos: brutos.size, bloqueio };
  log(`${SITE}: ${brutos.size} anúncios brutos (DF)`);
  const feat = (arr, re) => { const f = arr.find((s) => re.test(s)); return f ? num(f) : null; };
  // candidatos: preço ok e (texto casa com SS/JB ou localização genérica "Brasília" -> decide pela coordenada)
  const cands = [...brutos.values()].filter((c) => {
    const p = num(c.preco);
    if (!p || p > precoMax) return false;
    const t = norm(`${c.loc} ${c.end} ${c.href}`);
    return RE_JB.test(t) || RE_SS.test(t) || RE_BARTOLOMEU.test(t) || /^brasilia, distrito federal/.test(norm(c.loc));
  });
  const out = [];
  await pool(cands, 3, async (c) => {
    const link = 'https://www.casamineira.com.br' + c.href.split('?')[0];
    const k = conhecido({ link, preco: num(c.preco) });
    if (k) { // já conhecido com o mesmo preço: sem detalhe
      reaproveitar.total = (reaproveitar.total || 0) + 1;
      const regiao = classificar({ local: `${c.loc} | ${c.end} | ${c.href}`, titulo: c.desc, lat: k.lat, lon: k.lon });
      if (!regiao) return;
      const o = {};
      for (const cc of [...CAMPOS_CONHECIDOS, 'titulo', 'tipo']) if (k[cc] != null) o[cc] = k[cc]; // titulo/tipo: opcionais
      out.push(registro({
        site: SITE, titulo: c.desc.split('\n')[0].slice(0, 200), tipo: c.tipoUrl, regiao, bairro: c.loc.split(',')[0].trim() || null,
        endereco: [c.end, c.loc, 'DF'].filter(Boolean).join(', '), preco: num(c.preco),
        area_m2: feat(c.feats, /m² tot/i) || feat(c.feats, /m²/), quartos: feat(c.feats, /quarto/i),
        banheiros: feat(c.feats, /banh|ban\./i), vagas: feat(c.feats, /vaga/i), link, id_site: c.id, ...o,
      }));
      return;
    }
    const pg = await ctx.newPage();
    let txt = '', html = '';
    try {
      await pg.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await pg.waitForTimeout(500); // (antes 2 s) o conteúdo usado já vem no HTML do servidor
      txt = await pg.evaluate(() => document.body.innerText);
      html = await pg.content();
    } catch (e) { log(`${SITE} detalhe falhou ${link}: ${e.message}`); }
    finally { await pg.close(); }
    const b64 = (re) => { const m = html.match(re); if (!m) return null; try { return coord(Buffer.from(m[1], 'base64').toString()); } catch { return null; } };
    const lat = b64(/mapLatOf\s*=\s*"([^"]+)"/), lon = b64(/mapLngOf\s*=\s*"([^"]+)"/);
    const regiao = classificar({ local: `${c.loc} | ${c.end} | ${c.href}`, titulo: c.desc, lat, lon });
    if (!regiao) return;
    const pub = (txt.match(/(Publicado|Atualizado)[^\n]{0,40}/i) || [])[0] || '';
    const cabec = (txt.match(/\n((?:Apartamento|Casa|Cobertura|Kitnet|Studio|Flat|Loft|Sobrado)[^\n]*·[^\n]*)\n/i) || [])[1] || '';
    const descTitulo = (txt.match(/\n([^\n]{15,160}(?:para alugar|para loca[cç][aã]o|R\$[\d.,]+\/m[eê]s)[^\n]*)\n/i) || [])[1] || '';
    const cep = (txt.match(/\b(\d{5}-\d{3})\b/) || [])[1];
    const areaUtil = num((txt.match(/([\d.,]+)\s*m² útil/) || [])[1]);
    out.push(registro({
      site: SITE, titulo: (descTitulo || c.desc.split('\n')[0] || cabec).slice(0, 200),
      tipo: (cabec.split('·')[0] || c.tipoUrl).trim() || c.tipoUrl, regiao,
      bairro: c.loc.split(',')[0].trim() || null, endereco: [c.end, c.loc, 'DF'].filter(Boolean).join(', '), cep,
      lat, lon, preco: num(c.preco),
      condominio: pos((txt.match(/Condom[ií]nio R\$\s*([\d.,]+)/i) || [])[1] || (c.exp.match(/R\$\s*([\d.,]+)/) || [])[1]),
      iptu: pos((txt.match(/IPTU R\$\s*([\d.,]+)/i) || [])[1]),
      area_m2: areaUtil || feat(c.feats, /m² tot/i) || feat(c.feats, /m²/),
      quartos: feat(c.feats, /quarto/i), banheiros: feat(c.feats, /banh|ban\./i), vagas: feat(c.feats, /vaga/i),
      data_publicacao: dataRelativa(pub), data_tipo: /atualiz/i.test(pub) ? 'atualizado' : pub ? 'publicado' : null,
      link, id_site: c.id,
    }));
  });
  await ctx.close();
  return out;
}

// ------------------------------------------------------------------ orquestração
const aprovado = (a) => !!a.regiao && !excluido(a) && passaFiltro(a);

async function coletar({ precoMax = 1200, amplo = process.env.SSJB_AMPLO === '1' } = {}) {
  const stats = {};
  const todos = [];
  const rodar = async (nome, fn) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      const ok = r.filter(aprovado);
      if (process.env.SSJB_DEBUG) { // despeja os anúncios da região (aprovados ou não) para inspeção
        const f = path.join(__dirname, '..', 'data_ss', `debug_${norm(nome).replace(/[^a-z]+/g, '_')}.json`);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(r.filter((a) => a.regiao).map((a) => ({ ...a, _aprovado: aprovado(a), _excluido: excluido(a) })), null, 2));
      }
      stats[nome] = { ...(stats[nome] || {}), na_regiao: r.filter((a) => a.regiao).length, aprovados: ok.length, seg: Math.round((Date.now() - t0) / 1000) };
      todos.push(...ok);
      return ok;
    } catch (e) {
      stats[nome] = { ...(stats[nome] || {}), erro: e.message };
      log(`${nome} FALHOU: ${e.message}`);
      return [];
    }
  };

  // Tudo em paralelo: fetch puro (QuintoAndar, Loft, Lugar Certo) e o Chromium (um contexto por site).
  const browser = await novoBrowser();
  try {
    await Promise.all([
      rodar('QuintoAndar', async () => {
        const r = await quintoAndar(precoMax, stats);
        const ok = r.filter(aprovado);
        for (const a of ok) { if (reaproveitar(a)) continue; await quintoAndarDetalhe(a); await sleep(300); }
        return r;
      }),
      rodar('Loft', () => loft(precoMax, stats, amplo)),
      rodar('Lugar Certo', () => lugarCerto(precoMax, stats, amplo)),
      rodar('ZAP/VivaReal', () => zapVivaReal(browser, precoMax, stats)),
      rodar('Chaves na Mão', async () => {
        const { itens, ctx } = await chavesNaMao(browser, precoMax, stats);
        const cands = itens.filter(aprovado).filter((a) => !reaproveitar(a));
        await pool(cands, 3, (a) => chavesDetalhe(ctx, a));
        // detalhe pode ter trazido geo/área novas -> reclassifica
        for (const a of cands) if (a.lat != null && kmTerminal(a.lat, a.lon) > 18) a.regiao = null;
        await ctx.close();
        return itens;
      }),
      amplo ? rodar('Casa Mineira', () => casaMineira(browser, precoMax, stats)) : null,
    ]);
  } finally { await browser.close(); }

  const vistos = new Set();
  const final = todos
    .filter((a) => aprovado(a) && (vistos.has(a.link) ? false : vistos.add(a.link)))
    .sort((a, b) => (a.regiao === b.regiao ? a.preco - b.preco : a.regiao < b.regiao ? 1 : -1));
  const resumo = {};
  for (const a of final) { const k = `${a.site} | ${a.regiao}`; resumo[k] = (resumo[k] || 0) + 1; }
  if (reaproveitar.total) log(`conhecidos (sem detalhe): ${reaproveitar.total}`);
  log('stats', JSON.stringify(stats));
  log('resumo', JSON.stringify(resumo), `total ${final.length}, com lat/lon ${final.filter((a) => a.lat != null).length}`);
  coletar.ultimoStats = stats;
  return final;
}

if (require.main === module) {
  (async () => {
    const lista = await coletar({ precoMax: Number(process.env.PRECO_MAX) || 1200 });
    const out = path.join(__dirname, '..', 'data_ss', 'ss_jb_b.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(lista, null, 2));
    log(`salvo ${lista.length} anúncios em ${out}`);
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { coletar, classificar, TERMINAL_SS };
