// Crawler ZAP Imóveis + VivaReal (Grupo OLX) — aluguel residencial no DF.
// Estratégia: abre a página de busca do site com Playwright (passa pelo Cloudflare e pega cookies)
// e, de dentro da página, chama a glue-api interna (JSON) com fetch() + header x-domain.
// Fallback: se a API falhar, lê os cards renderizados no HTML.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { regiaoPermitida, passaFiltro } = require('./common');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_SIZE = 30; // limite da API (acima disso: "Size is above acceptable limit")
const MAX_PAGES = 20;

const SITES = [
  {
    nome: 'ZAP',
    home: 'https://www.zapimoveis.com.br/aluguel/imoveis/df+brasilia/?precoMaximo=1200&areaMinima=40',
    api: 'https://glue-api.zapimoveis.com.br/v2/listings',
    domain: '.zapimoveis.com.br',
    base: 'https://www.zapimoveis.com.br',
  },
  {
    nome: 'VivaReal',
    home: 'https://www.vivareal.com.br/aluguel/distrito-federal/brasilia/?precoMaximo=1200&areaMinima=40',
    api: 'https://glue-api.vivareal.com/v2/listings',
    domain: '.vivareal.com.br',
    base: 'https://www.vivareal.com.br',
  },
];

const INCLUDE = 'search(result(listings(listing(createdAt,updatedAt,title,id,address,bedrooms,bathrooms,' +
  'parkingSpaces,usableAreas,totalAreas,pricingInfos,unitTypes,usageTypes),link(href))),totalCount)';

function buildQuery(from) {
  const p = new URLSearchParams({
    business: 'RENTAL',
    parentId: 'null',
    listingType: 'USED',
    categoryPage: 'RESULT',
    unitTypes: 'APARTMENT,HOME,CONDOMINIUM',
    unitTypesV3: 'APARTMENT,HOME,CONDOMINIUM',
    usageTypes: 'RESIDENTIAL,RESIDENTIAL,RESIDENTIAL',
    addressCountry: 'Brasil',
    addressState: 'Distrito Federal',
    addressLocationId: 'BR>Distrito Federal',
    addressType: 'state',
    priceMax: '1200',
    usableAreasMin: '40',
    bedrooms: '1,2,3,4',
    size: String(PAGE_SIZE),
    from: String(from),
    page: String(Math.floor(from / PAGE_SIZE) + 1),
  });
  return p.toString() + '&includeFields=' + encodeURIComponent(INCLUDE);
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);
const TIPOS = { APARTMENT: 'Apartamento', HOME: 'Casa', CONDOMINIUM: 'Casa de condomínio' };

function mapear(item, site) {
  const l = item.listing || {};
  const a = l.address || {};
  const pr = (l.pricingInfos || []).find((x) => x.businessType === 'RENTAL') || first(l.pricingInfos) || {};
  const bairro = a.neighborhood || (a.locationId || '').split('>').pop() || null;
  const endereco = [a.street, a.streetNumber].filter(Boolean).join(', ') || a.fullAddress || null;
  const titulo = l.title || null;
  const regiao = regiaoPermitida([bairro, a.city, a.fullAddress, a.locationId, endereco, titulo].join(' | '));
  let href = item.link && item.link.href;
  let link = href ? new URL(href, site.base).toString() : `${site.base}/imovel/id-${l.id}/`;
  link = link.split('?')[0];
  const created = l.createdAt ? l.createdAt.slice(0, 10) : null;
  const updated = l.updatedAt ? l.updatedAt.slice(0, 10) : null;
  return {
    site: site.nome,
    titulo,
    tipo: TIPOS[first(l.unitTypes)] || first(l.unitTypes) || null,
    regiao,
    bairro,
    endereco,
    preco: num(pr.price),
    condominio: num(pr.monthlyCondoFee),
    iptu: num(pr.iptu) ?? num(pr.yearlyIptu),
    area_m2: num(first(l.usableAreas)) ?? num(first(l.totalAreas)),
    quartos: num(first(l.bedrooms)),
    banheiros: num(first(l.bathrooms)),
    vagas: num(first(l.parkingSpaces)),
    data_publicacao: created || updated,
    data_tipo: created ? 'publicado' : updated ? 'atualizado' : null,
    link,
    coletado_em: new Date().toISOString(),
  };
}

async function coletarSite(browser, site) {
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  const page = await ctx.newPage();
  const brutos = [];
  const stats = { site: site.nome, brutos: 0, total_api: null, bloqueio: null };
  try {
    const resp = await page.goto(site.home, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const title = await page.title();
    if (!resp || resp.status() >= 400 || /attention required|just a moment|cloudflare/i.test(title)) {
      stats.bloqueio = `home status ${resp && resp.status()} title "${title}"`;
    }
    await page.waitForTimeout(1500 + Math.random() * 1000); // (antes 3–5 s; sem rate-limit observado)

    for (let pg = 0; pg < MAX_PAGES; pg++) {
      const url = `${site.api}?${buildQuery(pg * PAGE_SIZE)}`;
      const r = await page.evaluate(async ([u, dom]) => {
        try {
          const res = await fetch(u, { headers: { 'x-domain': dom } });
          return { s: res.status, t: await res.text() };
        } catch (e) { return { s: 0, t: String(e) }; }
      }, [url, site.domain]);
      if (r.s !== 200) {
        stats.bloqueio = `API status ${r.s}: ${r.t.slice(0, 120)}`;
        break;
      }
      const j = JSON.parse(r.t);
      const L = (j.search && j.search.result && j.search.result.listings) || [];
      stats.total_api = j.search && j.search.totalCount;
      brutos.push(...L);
      console.error(`[${site.nome}] página ${pg + 1}: ${L.length} (total API ${stats.total_api})`);
      if (L.length < PAGE_SIZE || brutos.length >= stats.total_api) break;
      await page.waitForTimeout(600 + Math.random() * 750);
    }
  } catch (e) {
    stats.bloqueio = `erro: ${e.message}`;
  } finally {
    await ctx.close();
  }
  stats.brutos = brutos.length;
  return { itens: brutos.map((x) => mapear(x, site)), stats };
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const todos = [];
  const allStats = [];
  try {
    for (const site of SITES) {
      const { itens, stats } = await coletarSite(browser, site);
      const ok = itens.filter((a) => a.regiao && passaFiltro(a));
      stats.passaram = ok.length;
      allStats.push(stats);
      todos.push(...ok);
    }
  } finally {
    await browser.close();
  }
  const vistos = new Set();
  const final = todos.filter((a) => (vistos.has(a.link) ? false : vistos.add(a.link)));
  const out = path.join(__dirname, '..', 'data', 'zap_vivareal.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(final, null, 2));
  console.log(JSON.stringify({ stats: allStats, salvos: final.length, arquivo: out }, null, 2));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main };
