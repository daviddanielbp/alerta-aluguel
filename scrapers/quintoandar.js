// Crawler QuintoAndar - aluguel residencial no DF (aluguel <= R$ 1.200).
// Usa a API interna de busca (apigw.prod.quintoandar.com.br/house-listing-search/v2/search/list),
// a mesma que o site chama, e visita cada anúncio para obter a data de publicação.
// Se a API falhar, cai para Playwright interceptando as respostas da página de busca.
const fs = require('fs');
const path = require('path');
const { regiaoPermitida, passaFiltro, FILTRO } = require('./common');

const API = 'https://apigw.prod.quintoandar.com.br/house-listing-search/v2/search/list';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const OUT = path.join(__dirname, '..', 'data', 'quintoandar.json');
const PAGE_SIZE = 50;
const FIELDS = ['id', 'type', 'rent', 'totalCost', 'condominium', 'iptu', 'area', 'bedrooms', 'bathrooms',
  'parkingSpaces', 'address', 'neighbourhood', 'city', 'regionName', 'shortRentDescription', 'isFurnished'];

// Viewport cobrindo todo o DF (mesmo usado pela página brasilia-df-brasil).
const VIEWPORT = { lat: -15.826691, lng: -47.92182, north: -15.29, south: -16.37, east: -47.35, west: -48.64 };

const { reaproveitar } = require('./known'); // KNOWN_LINKS_FILE: conhecido com o mesmo preço -> sem detalhe
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildQuery(offset) {
  const p = new URLSearchParams({
    'context.listShowing': 'true',
    'context.numPhotos': '0',
    'context.isSSR': 'false',
    'filters.businessContext': 'RENT',
    'filters.location.coordinate.lat': VIEWPORT.lat,
    'filters.location.coordinate.lng': VIEWPORT.lng,
    'filters.location.viewport.east': VIEWPORT.east,
    'filters.location.viewport.north': VIEWPORT.north,
    'filters.location.viewport.south': VIEWPORT.south,
    'filters.location.viewport.west': VIEWPORT.west,
    'filters.location.countryCode': 'BR',
    'filters.priceRange[0].costType': 'RENT_PRICE',
    'filters.priceRange[0].range.min': '0',
    'filters.priceRange[0].range.max': String(FILTRO.precoMax),
    'filters.availability': 'ANY',
    'filters.occupancy': 'ANY',
    'pagination.pageSize': String(PAGE_SIZE),
    'pagination.offset': String(offset),
  });
  FIELDS.forEach((f, i) => p.append(`fields[${i}]`, f));
  return `${API}?${p}`;
}

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://www.quintoandar.com.br', Referer: 'https://www.quintoandar.com.br/' } });
      if (r.ok) return await r.json();
      console.error(`HTTP ${r.status} em ${url.slice(0, 100)}`);
    } catch (e) { console.error('erro fetch:', e.message); }
    await sleep(1500 * (i + 1));
  }
  return null;
}

// Busca todas as páginas via API. Retorna array de _source.
async function buscarViaApi() {
  const out = [];
  let offset = 0, total = Infinity;
  while (offset < total) {
    const j = await getJson(buildQuery(offset));
    if (!j || !j.hits) { if (offset === 0) return null; break; }
    total = (j.hits.total && j.hits.total.value) || 0;
    const hits = j.hits.hits || [];
    if (!hits.length) break;
    hits.forEach((h) => out.push(h._source));
    offset += hits.length;
    console.log(`API: ${out.length}/${total}`);
    await sleep(500);
  }
  return out;
}

// Fallback: abre a página de busca no Playwright e captura as respostas da API.
async function buscarViaPlaywright() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const out = [];
  try {
    const page = await browser.newPage({ userAgent: UA, locale: 'pt-BR' });
    page.on('response', async (r) => {
      if (!/house-listing-search\/v2\/search\/list/.test(r.url())) return;
      try { const j = await r.json(); (j.hits?.hits || []).forEach((h) => out.push(h._source)); } catch (_) { }
    });
    await page.goto('https://www.quintoandar.com.br/alugar/imovel/brasilia-df-brasil/de-500-a-1200-reais', { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(1200);
      const btn = page.getByRole('button', { name: /ver mais/i });
      if (await btn.count()) await btn.first().click().catch(() => { });
    }
    // Também aproveita o estado SSR.
    const houses = await page.evaluate(() => {
      const e = document.getElementById('__NEXT_DATA__');
      try { return Object.values(JSON.parse(e.textContent).props.pageProps.initialState.houses); } catch (_) { return []; }
    });
    houses.forEach((h) => out.push({
      id: h.id, type: h.type, rent: h.rentPrice, totalCost: h.totalCost, area: h.area, bedrooms: h.bedrooms,
      bathrooms: h.bathrooms, parkingSpaces: h.parkingSpots, address: h.address?.address, city: h.address?.city,
      neighbourhood: h.neighbourhood, regionName: h.regionName, shortRentDescription: h.shortRentDescription,
    }));
  } finally { await browser.close(); }
  return out;
}

const isoDate = (s) => (s ? String(s).slice(0, 10) : null);

// Visita a página do anúncio para pegar datas de publicação (firstPublicationDate / lastPublicationDate).
async function datasDoAnuncio(id) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://www.quintoandar.com.br/imovel/${id}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR' }, redirect: 'follow' });
      if (!r.ok) { await sleep(1500); continue; }
      const html = await r.text();
      // Preferir a entrada de listing RENT.
      const m = html.match(/"imovelId":\d+,"businessContext":"RENT","status":"[^"]*","firstPublicationDate":"([^"]+)","lastPublicationDate":"([^"]+)"/)
        || html.match(/"firstPublicationDate":"([^"]+)"[^}]*?"lastPublicationDate":"([^"]+)"/);
      if (m) return { first: isoDate(m[1]), last: isoDate(m[2]), url: r.url };
      const lp = html.match(/"lastPublishedDate":"([^"]+)"/);
      return { first: null, last: lp ? isoDate(lp[1]) : null, url: r.url };
    } catch (e) { await sleep(1500); }
  }
  return { first: null, last: null, url: null };
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

async function main() {
  let brutos = await buscarViaApi();
  if (!brutos) {
    console.log('API direta falhou; tentando Playwright...');
    brutos = await buscarViaPlaywright();
  }
  console.log(`Anúncios brutos: ${brutos.length}`);

  const coletado_em = new Date().toISOString();
  const vistos = new Set();
  const candidatos = [];
  for (const s of brutos) {
    const link = `https://www.quintoandar.com.br/imovel/${s.id}`;
    if (vistos.has(link)) continue;
    vistos.add(link);
    const tipo = s.type || null;
    const titulo = s.shortRentDescription || `${tipo || 'Imóvel'} para alugar em ${s.neighbourhood || ''}`;
    // regionName do QuintoAndar é um agrupamento amplo (ex.: "Asa Norte" para Itapoã), por isso não é usado.
    // Grafias alternativas usadas pelos anunciantes (ex.: "Itapuã Parque" = Itapoã).
    const textoLocal = [s.neighbourhood, s.city, s.address, titulo].filter(Boolean).join(' | ')
      .replace(/itapu[aã]/gi, 'Itapoã');
    const regiao = regiaoPermitida(textoLocal);
    const a = {
      site: 'QuintoAndar',
      titulo,
      tipo,
      regiao,
      bairro: s.neighbourhood || null,
      endereco: [s.address, s.neighbourhood, s.city, 'DF'].filter(Boolean).join(', '),
      preco: num(s.rent),
      total: num(s.totalCost),
      condominio: num(s.condominium),
      iptu: num(s.iptu),
      area_m2: num(s.area) || null,
      quartos: num(s.bedrooms),
      banheiros: num(s.bathrooms),
      vagas: num(s.parkingSpaces),
      data_publicacao: null,
      data_tipo: null,
      link,
      coletado_em,
    };
    // Tipo kitnet/studio -> descarta.
    if (/studio|kitnet|kitchenette|quarto/i.test(tipo || '')) continue;
    if (!a.regiao || !passaFiltro(a)) continue;
    candidatos.push(a);
  }

  for (const a of candidatos) {
    if (reaproveitar(a)) continue;
    const d = await datasDoAnuncio(a.link.split('/').pop());
    if (d.first) { a.data_publicacao = d.first; a.data_tipo = 'publicado'; }
    else if (d.last) { a.data_publicacao = d.last; a.data_tipo = 'atualizado'; }
    if (d.last && d.last !== d.first) a.data_atualizacao = d.last;
    await sleep(400);
  }

  candidatos.sort((x, y) => x.preco - y.preco);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(candidatos, null, 2));
  console.log(`Passaram no filtro: ${candidatos.length} -> ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
