// Crawler ImovelWeb / Wimoveis (mesma plataforma Navent) — aluguel residencial no DF até R$ 1.200.
// Estratégia: Chromium em modo "new headless" (channel 'chromium'), que passa pelo Cloudflare;
// abre a listagem filtrada (URL -menos-1200-reales.html) para obter cookies/sessão e então
// chama a API interna POST /rplis-api/postings de dentro da página (fetch same-origin), paginando.
// A data de publicação só aparece na página do anúncio ("Publicado há X dias"), então ela é
// buscada (fetch same-origin) apenas para os anúncios que já passaram no filtro (e que não estão no
// KNOWN_LINKS_FILE com o mesmo preço — ver scrapers/known.js).
// ImovelWeb e Wimoveis têm o MESMO inventário (mesmo id e mesmo caminho de URL), então só o ImovelWeb
// é consultado e o link do Wimoveis vai em `link_wimoveis`. IMOVELWEB_AMBOS=1 volta a varrer os dois.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { regiaoPermitida, passaFiltro, FILTRO } = require('./common');
const { reaproveitar } = require('./known');

const HOJE = new Date(); // datas relativas ('há 3 dias') contam a partir de agora
const OUT = path.join(__dirname, '..', 'data', 'imovelweb.json');
const MAX_PAGES = 20;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const TODOS_SITES = [
  { site: 'ImovelWeb', base: 'https://www.imovelweb.com.br', listing: '/imoveis-aluguel-distrito-federal-menos-1200-reales.html',
    fallback: '/apartamentos-aluguel-distrito-federal-menos-1200-reales.html' },
  { site: 'Wimoveis', base: 'https://www.wimoveis.com.br', listing: '/aluguel/imoveis/df', fallback: '/aluguel/apartamentos/df' },
];

const SITES = process.env.IMOVELWEB_AMBOS === '1' ? TODOS_SITES : TODOS_SITES.slice(0, 1);
const WIMOVEIS = 'https://www.wimoveis.com.br';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const iso = (d) => d.toISOString().slice(0, 10);
const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };

const decode = (s) => { let t = String(s); for (let i = 0; i < 2; i++) t = t.replace(/&amp;/g, '&'); return t.replace(/&ordm;/g, 'º').replace(/&ordf;/g, 'ª').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)); };
const TIPOS_RESIDENCIAIS = /apartamento|casa|cobertura|flat|sobrado|duplex|triplex|loft|condom[ií]nio/i;
const TIPOS_EXCLUIDOS = /kit|studio|quarto|comercia|terreno|lote|sala|loja|galp|pr[eé]dio|rural|ch[aá]cara|fazenda|garagem|box|dep[oó]sito/i;

function dataRelativa(txt) {
  if (!txt) return null;
  const t = txt.toLowerCase();
  const d = new Date(HOJE);
  if (/hoje|hora|minuto|segundo/.test(t)) return iso(d);
  if (/ontem/.test(t)) { d.setUTCDate(d.getUTCDate() - 1); return iso(d); }
  let m = t.match(/(\d+)\s*dias?/); if (m) { d.setUTCDate(d.getUTCDate() - +m[1]); return iso(d); }
  m = t.match(/(\d+)\s*semanas?/); if (m) { d.setUTCDate(d.getUTCDate() - 7 * m[1]); return iso(d); }
  m = t.match(/(\d+)\s*(m[eê]s|meses)/); if (m) { d.setUTCMonth(d.getUTCMonth() - +m[1]); return iso(d); }
  if (/um m[eê]s|1 m[eê]s/.test(t)) { d.setUTCMonth(d.getUTCMonth() - 1); return iso(d); }
  m = t.match(/(\d+)\s*anos?/); if (m) { d.setUTCFullYear(d.getUTCFullYear() - +m[1]); return iso(d); }
  if (/um ano/.test(t)) { d.setUTCFullYear(d.getUTCFullYear() - 1); return iso(d); }
  return null;
}

function mapPosting(p, site, base) {
  const feat = p.mainFeatures || {};
  const fv = (id) => (feat[id] ? num(feat[id].value) : null);
  const op = (p.priceOperationTypes || []).find((o) => /alug/i.test(o.operationType?.name || '')) || (p.priceOperationTypes || [])[0];
  const preco = op?.prices?.[0]?.amount ?? null;
  const loc = p.postingLocation || {};
  const zona = loc.location?.label === 'ZONA' ? loc.location?.name : null;
  const cidade = loc.location?.label === 'ZONA' ? loc.location?.parent?.name : loc.location?.name;
  const endereco = loc.address?.name || null;
  const tipoRaw = p.realEstateType?.name || '';
  const tipo = tipoRaw.replace(/s$/, '').replace(/oe$/, 'ão') || null;
  const titulo = decode(p.title || p.generatedTitle || '').trim();
  const regiao = regiaoPermitida([zona, cidade, endereco, titulo].filter(Boolean).join(' | '));
  const link = new URL(p.url, base).href.split('?')[0];
  return {
    site, titulo, tipo, regiao,
    bairro: zona || cidade || null,
    cidade: cidade || null,
    endereco,
    preco: preco != null ? Number(preco) : null,
    condominio: p.expenses?.amount ? Number(p.expenses.amount) : null,
    iptu: p.iptu?.amount ? Number(p.iptu.amount) : (typeof p.iptu === 'number' && p.iptu > 0 ? p.iptu : null),
    area_m2: fv('CFT101') ?? fv('CFT100'),
    quartos: fv('CFT2'), banheiros: fv('CFT3'), vagas: fv('CFT7'),
    data_publicacao: null, data_tipo: null,
    link,
    coletado_em: new Date().toISOString(),
    _id: String(p.postingId), _tipoRaw: tipoRaw,
  };
}

async function newContext(browser) {
  const ctx = await browser.newContext({ userAgent: UA, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' } });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en'] });
    window.chrome = window.chrome || { runtime: {} };
  });
  return ctx;
}

async function fetchPage(page, body) {
  return page.evaluate(async (b) => {
    const res = await fetch('/rplis-api/postings', { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' }, body: JSON.stringify(b) });
    const t = await res.text();
    try { return { status: res.status, json: JSON.parse(t) }; } catch { return { status: res.status, json: null, text: t.slice(0, 200) }; }
  }, body);
}

async function crawlSite(browser, cfg, stats) {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const out = [];
  try {
    await page.goto(cfg.base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(rand(1200, 2200));
    let resp = await page.goto(cfg.base + cfg.listing, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!resp || resp.status() >= 400) {
      console.log(`[${cfg.site}] listagem ${cfg.listing} -> ${resp && resp.status()}, tentando fallback`);
      await sleep(rand(1000, 2000));
      resp = await page.goto(cfg.base + cfg.fallback, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await sleep(rand(1500, 2500));
    const title = await page.title();
    console.log(`[${cfg.site}] ${resp && resp.status()} ${page.url()} | ${title}`);
    if (/just a moment|attention required/i.test(title)) { stats.bloqueios.push(`${cfg.site}: Cloudflare na listagem`); return out; }

    // Tipos: 1=Casas, 2=Apartamentos (e demais tipos residenciais como cobertura/sobrado são subtipos).
    // A ordem 'relevance' pode mudar entre páginas (anúncio pula de página e some da varredura); se o
    // nº de ids únicos ficar abaixo do total, faz uma 2ª passada com outra ordenação para completar.
    const idsVistos = new Set();
    for (const [tipo, sort] of [['2', 'relevance'], ['1', 'relevance'], ['2', 'more_recent'], ['1', 'more_recent']]) {
      if (sort !== 'relevance') {
        const tot = stats.totais?.[tipo];
        const achados = out.filter((a) => a._tipoBusca === tipo).length;
        if (tot == null || achados >= tot) continue;
        console.log(`[${cfg.site}] tipo ${tipo}: ${achados}/${tot} únicos -> 2ª passada (sort=${sort})`);
      }
      for (let pagina = 1; pagina <= MAX_PAGES; pagina++) {
        const body = { q: null, moneda: '3', preciomax: FILTRO.precoMax, tipoDePropiedad: tipo, tipoDeOperacion: '2', province: '247',
          pagina, sort, tipoAnunciante: 'ALL', habitacionesminimo: 0, habitacionesmaximo: 0 };
        let r = await fetchPage(page, body);
        if (r.status !== 200 || !r.json) {
          console.log(`[${cfg.site}] tipo ${tipo} pág ${pagina}: HTTP ${r.status} ${r.text || ''}`);
          await sleep(rand(6000, 9000));
          r = await fetchPage(page, body);
          if (r.status !== 200 || !r.json) { stats.bloqueios.push(`${cfg.site}: API ${r.status} tipo ${tipo} pág ${pagina}`); break; }
        }
        const list = r.json.listPostings || [];
        const pg = r.json.paging || {};
        console.log(`[${cfg.site}] tipo ${tipo} pág ${pagina}/${pg.totalPages} -> ${list.length} anúncios (total ${pg.total})`);
        if (sort === 'relevance' && pg.total != null) (stats.totais = stats.totais || {})[tipo] = pg.total;
        for (const p of list) {
          if (idsVistos.has(String(p.postingId))) continue;
          idsVistos.add(String(p.postingId));
          const a = mapPosting(p, cfg.site, cfg.base);
          a._tipoBusca = tipo;
          out.push(a);
        }
        if (!list.length || pg.lastPage || pagina >= (pg.totalPages || 0)) break;
        await sleep(rand(700, 1700));
      }
    }
    stats.page = page; stats.ctxs.push(ctx);
    return out;
  } catch (e) {
    stats.bloqueios.push(`${cfg.site}: erro ${e.message.split('\n')[0]}`);
    console.log(`[${cfg.site}] erro`, e.message.split('\n')[0]);
    return out;
  } finally {
    if (!stats.ctxs.includes(ctx)) await ctx.close().catch(() => {});
  }
}

async function datasPublicacao(page, anuncios) {
  for (const a of anuncios) {
    try {
      const html = await page.evaluate(async (u) => { const r = await fetch(u, { credentials: 'include' }); return r.status === 200 ? r.text() : 'HTTP' + r.status; }, a.link);
      const txt = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const m = txt.match(/(Publicado|Atualizado)\s+(h[aá]\s+(mais de\s+)?\d+\s+\w+|h[aá]\s+(um|uma)\s+\w+|desde\s+\w+|hoje|ontem)/i);
      if (m) { a.data_publicacao = dataRelativa(m[2]); a.data_tipo = /atualiz/i.test(m[1]) ? 'atualizado' : 'publicado'; }
      else if (html.startsWith('HTTP')) console.log('  detalhe', html, a.link);
    } catch (e) { console.log('  detalhe erro', a.link, e.message.split('\n')[0]); }
    await sleep(rand(400, 1000));
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const stats = { bloqueios: [], ctxs: [] };
  let brutos = [];
  const pageBySite = {};
  for (const cfg of SITES) {
    const got = await crawlSite(browser, cfg, stats);
    if (stats.page) { pageBySite[cfg.site] = stats.page; stats.page = null; }
    brutos = brutos.concat(got);
  }
  // Dedup por id do anúncio (ImovelWeb e Wimoveis compartilham inventário) e por link.
  const vistosId = new Set(); const vistosLink = new Set(); const unicos = [];
  for (const a of brutos) { if (vistosId.has(a._id) || vistosLink.has(a.link)) continue; vistosId.add(a._id); vistosLink.add(a.link); unicos.push(a); }

  const tipos = {}; for (const a of unicos) tipos[a._tipoRaw] = (tipos[a._tipoRaw] || 0) + 1;
  console.log('Tipos:', tipos);

  const aprovados = unicos.filter((a) => a.regiao && passaFiltro(a)
    && !TIPOS_EXCLUIDOS.test(a._tipoRaw) && (TIPOS_RESIDENCIAIS.test(a._tipoRaw) || !a._tipoRaw)
    && !/\bkit\b|kitnet|quitinete|kitinete|temporada|\bflat\b.*\bquarto\b/i.test(a.titulo));
  console.log(`Brutos: ${brutos.length} | únicos: ${unicos.length} | aprovados: ${aprovados.length}`);

  // Datas de publicação a partir da página do anúncio (só dos aprovados que não estão no KNOWN_LINKS_FILE).
  const conhecidos = aprovados.filter((a) => reaproveitar(a));
  if (conhecidos.length) console.log(`Conhecidos (sem detalhe): ${conhecidos.length}`);
  const conhecidosSet = new Set(conhecidos);
  for (const site of Object.keys(pageBySite)) {
    const lote = aprovados.filter((a) => a.site === site && !conhecidosSet.has(a));
    console.log(`Buscando datas de ${lote.length} anúncios (${site})...`);
    await datasPublicacao(pageBySite[site], lote);
  }

  const final = aprovados.map(({ _id, _tipoRaw, _tipoBusca, cidade, ...a }) => {
    if (a.site === 'ImovelWeb') a.link_wimoveis = WIMOVEIS + new URL(a.link).pathname; // mesmo anúncio, mesmo caminho
    return a;
  });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(final, null, 2));
  console.log(`Salvo ${final.length} anúncios em ${OUT}`);
  if (stats.bloqueios.length) console.log('Ocorrências:', stats.bloqueios);
  for (const c of stats.ctxs) await c.close().catch(() => {});
  await browser.close();
})();
