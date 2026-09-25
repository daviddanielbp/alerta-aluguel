// Crawler de aluguel residencial no DF em portais secundários:
//   - Lugar Certo (Correio Braziliense)  -> HTML + JSON embutido (window.dados_anuncios / window.detalheanuncio)
//   - Loft                                -> API interna landscape-api (ordenada por preço crescente)
//   - Netimóveis                          -> HTML + ld+json (filtro precoMax=1200 na URL)
//   - Casa Mineira (plataforma Imovelweb) -> Playwright (cards + página do anúncio)
// Saída: data/outros.json
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { regiaoPermitida, passaFiltro, FILTRO } = require('./common');
const { conhecido, CAMPOS: CAMPOS_CONHECIDOS } = require('./known');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const HOJE = new Date(); // datas relativas ('há 3 dias') contam a partir de agora
const MAX_PAGINAS = 15;
const coletado_em = new Date().toISOString();
const stats = {};

// ---------------- utilidades ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[^\d,.-]/g, '');
  if (!s) return null;
  // formato BR: 1.234,56
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/\.(?=\d{3}(\D|$))/g, ''));
  return Number.isFinite(n) ? n : null;
}
// KNOWN_LINKS_FILE (scrapers/known.js): anúncio já visto com o mesmo preço -> não abre o detalhe.
let nConhecidos = 0;
function doConhecido(link, preco) {
  const k = conhecido({ link, preco });
  if (!k) return null;
  nConhecidos++;
  const o = {};
  // titulo/tipo vêm da página do anúncio aqui: usa os do JSON quando presentes (campos opcionais).
  for (const c of [...CAMPOS_CONHECIDOS, 'titulo', 'tipo']) if (k[c] != null) o[c] = k[c];
  return o;
}
const pos = (v) => { const n = num(v); return n && n > 0 ? n : null; };
const isoDia = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : null);
function isoDe(s) { if (!s) return null; const d = new Date(s); return isoDia(d); }
function dataRelativa(txt) {
  if (!txt) return null;
  const t = txt.toLowerCase();
  const d = new Date(HOJE);
  if (/\bhoje\b/.test(t)) return isoDia(d);
  if (/\bontem\b/.test(t)) { d.setUTCDate(d.getUTCDate() - 1); return isoDia(d); }
  let m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/(mais de )?(\d+|um|uma)\s*(minuto|hora|dia|semana|m[eê]s|mes|ano)/);
  if (m) {
    const n = /^\d+$/.test(m[2]) ? Number(m[2]) : 1;
    const u = m[3];
    if (u.startsWith('dia')) d.setUTCDate(d.getUTCDate() - n);
    else if (u.startsWith('semana')) d.setUTCDate(d.getUTCDate() - 7 * n);
    else if (u.startsWith('m')) d.setUTCMonth(d.getUTCMonth() - n);
    else if (u.startsWith('ano')) d.setUTCFullYear(d.getUTCFullYear() - n);
    return isoDia(d);
  }
  return null;
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
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; log('  erro item', k, e.message); } }
  }));
  return out;
}

// Extrai um objeto JSON literal a partir de um índice (casando chaves, respeitando strings).
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

const RE_NAO_RESID = /quitinete|kit ?net|kitchenette|kitinete|studio|est[uú]dio|conjugad|quarto\/vaga|\bvaga\b|sala|loja|garagem|galp[aã]o|lote|terreno|pr[eé]dio|ponto comercial|hotel|motel|pousada|ch[aá]cara|fazenda|s[ií]tio|rural|andar|pilotis/i;

function finalizar(a) {
  a.regiao = regiaoPermitida([a.bairro, a.cidade, a.endereco, a.titulo].filter(Boolean).join(' | '));
  delete a.cidade;
  a.coletado_em = coletado_em;
  return a;
}
// passaFiltro + descarte explícito de tipos não residenciais / kitnet (ex.: 'Quitinete', 'Kitchenette' não casam com a regex do common)
function aprovado(a) { return !!a.regiao && !RE_NAO_RESID.test(a.tipo || '') && passaFiltro(a); }

// ---------------- Lugar Certo ----------------
async function lugarCerto() {
  const site = 'Lugar Certo';
  const base = 'https://correiobraziliense.lugarcerto.com.br/busca/aluguel/df';
  const brutos = [];
  let totalPag = null;
  for (let p = 0; p < 16; p++) { // 16 páginas x 20 = todos os ~308 anúncios de aluguel do DF
    const url = p ? `${base}?offset=${p * 20}` : base;
    const html = await getText(url);
    const re = /window\.dados_anuncios\["(\d+)"\]=/g;
    let m, n = 0;
    while ((m = re.exec(html))) { const d = extrairJSON(html, m.index + m[0].length); if (d) { brutos.push(d); n++; } }
    const tp = html.match(/max="(\d+)"[^>]*value="\d+"[^>]*>\s*<input[^>]*>\s*de (\d+)/);
    if (tp) totalPag = Number(tp[2]);
    log(`[${site}] página ${p + 1}${totalPag ? '/' + totalPag : ''}: ${n} anúncios`);
    if (!n || (totalPag && p + 1 >= totalPag)) break;
    await sleep(400);
  }
  stats[site] = { brutos: brutos.length };

  const cands = brutos.filter((d) => {
    const preco = num(d.preco);
    return preco && preco <= FILTRO.precoMax && !RE_NAO_RESID.test((d.descricaoanuncio || '').split(',')[0]);
  });
  log(`[${site}] ${cands.length} candidatos residenciais <= R$${FILTRO.precoMax}; abrindo páginas dos anúncios`);

  const res = await pool(cands, 4, async (d) => {
    const link = 'https:' + d.urldestino.replace(/^https?:/, '');
    const k = doConhecido(link, num(d.preco));
    if (k) {
      return finalizar({
        site, titulo: d.descricaoanuncio, tipo: (d.descricaoanuncio || '').split(',')[0].trim(),
        bairro: d.bairro || null, cidade: d.local || null,
        endereco: [d.endereco, d.bairro, d.local].filter(Boolean).join(', '), preco: num(d.preco),
        condominio: null, iptu: null, area_m2: pos(d.area), quartos: d.numquartos ?? null,
        banheiros: d.numbanheiros ?? null, vagas: d.numvagas ?? null, data_publicacao: null, data_tipo: null,
        link, ...k,
      });
    }
    let det = {};
    try {
      const html = await getText(link);
      const i = html.indexOf('window.detalheanuncio=');
      if (i >= 0) det = extrairJSON(html, i) || {};
    } catch (e) { log(`[${site}] detalhe falhou ${link}: ${e.message}`); }
    const tipo = det.sc_tipoimovel || (d.descricaoanuncio || '').split(',')[0].trim();
    const dt = det.dt_atualizacao || det.dt_alteracao;
    return finalizar({
      site, titulo: det.sc_titulodescricao || d.descricaoanuncio, tipo,
      bairro: d.bairro || null, cidade: d.local || null,
      endereco: [d.endereco, d.bairro, d.local].filter(Boolean).join(', '),
      preco: num(d.preco),
      condominio: pos(det.dc_precocondominio ?? det.dc_condominio),
      iptu: pos(det.dc_iptu),
      area_m2: pos(d.area ?? det.ia_areaconstruida ?? det.ia_areautil ?? det.ia_areatotal),
      quartos: d.numquartos ?? det.ia_quarto ?? null,
      banheiros: d.numbanheiros ?? det.ia_banheiro ?? null,
      vagas: d.numvagas ?? det.ia_vaga ?? null,
      data_publicacao: isoDe(dt || det.dt_insercao),
      data_tipo: dt ? 'atualizado' : det.dt_insercao ? 'publicado' : null,
      link,
    });
  });
  return res.filter(Boolean);
}

// ---------------- Loft ----------------
async function loft() {
  const site = 'Loft';
  const api = 'https://landscape-api.loft.com.br/listing/v2/search';
  const headers = { 'x-origin': 'http://loft-website-sales.loft.com.br', Accept: 'application/json', Origin: 'https://loft.com.br', Referer: 'https://loft.com.br/' };
  const brutos = [];
  for (let p = 0; p < MAX_PAGINAS; p++) {
    // orderBy=priceOfSale ordena pelo aluguel crescente -> paramos quando passar de R$ 1.200
    const qs = `orderBy%5B%5D=priceOfSale&cities%5B%5D=brasilia%2C+df&transactionType%5B%5D=for_rent&hitsPerPage=38${p ? '&page=' + p : ''}`;
    const d = JSON.parse(await getText(`${api}?${qs}`, headers));
    const ls = d.listings || [];
    brutos.push(...ls);
    const ultimo = ls.length ? ls[ls.length - 1].rentalPrice : null;
    log(`[${site}] página ${p + 1}/${d.pagination?.totalPages}: ${ls.length} anúncios (último aluguel R$ ${ultimo})`);
    if (!ls.length || ultimo > FILTRO.precoMax || p + 1 >= (d.pagination?.totalPages || 0)) break;
    await sleep(400);
  }
  stats[site] = { brutos: brutos.length };

  const slug = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const out = [];
  for (const l of brutos) {
    if (!(l.rentalPrice > 0 && l.rentalPrice <= FILTRO.precoMax)) continue;
    if (l.rentalPeriod && l.rentalPeriod !== 'MONTHLY') continue; // descarta diária/temporada
    if (l.usageType && l.usageType !== 'residential') continue;
    if (!/apartment|house/i.test(l.homeType || '')) continue;
    const ptype = l.propertyType || '';
    const tipo = /house/i.test(l.homeType) ? 'Casa' : 'Apartamento';
    const extra = /studio/i.test(ptype) ? ' (Studio)' : /conjugate/i.test(ptype) ? ' (Conjugado/Kitnet)' : '';
    const a = l.address || {};
    const q = l.bedrooms;
    const titulo = `${tipo}${extra} ${q != null ? q + (q === 1 ? ' quarto' : ' quartos') : ''} ${l.area ? l.area + 'm²' : ''} - ${a.streetFullName || a.streetName || ''}, ${a.neighborhood || ''}`.replace(/\s+/g, ' ').trim();
    const linkSlug = slug([tipo, a.streetName, a.neighborhood, a.city, q != null ? `${q}-quarto${q === 1 ? '' : 's'}` : '', l.area ? `${l.area}m2` : ''].join(' '));
    out.push(finalizar({
      site, titulo, tipo: tipo + extra,
      bairro: a.neighborhood || null, cidade: [a.city, a.state].filter(Boolean).join(' - '),
      endereco: [a.streetFullName || a.streetName, a.number, a.neighborhood, a.city, a.state].filter(Boolean).join(', '),
      preco: l.rentalPrice,
      condominio: pos(l.complexFee), iptu: pos(l.propertyTax),
      area_m2: pos(l.area), quartos: l.bedrooms ?? null, banheiros: l.restrooms ?? null, vagas: l.parkingSpots ?? null,
      data_publicacao: isoDe(l.createdAt), data_tipo: l.createdAt ? 'publicado' : null,
      link: `https://loft.com.br/imovel/${linkSlug}/${l.id}?tipoTransacao=aluguel`,
    }));
    // studio/conjugado: marcar no título faz o passaFiltro descartar
  }
  return out;
}

// ---------------- Netimóveis ----------------
async function netimoveis() {
  const site = 'Netimóveis';
  const buscas = [
    'https://www.netimoveis.com/locacao/distrito-federal/brasilia/apartamento?tipo=apartamento&localizacao=BR-DF-brasilia---&transacao=locacao&precoMax=1200',
    'https://www.netimoveis.com/locacao/distrito-federal/brasilia/casa?tipo=casa&localizacao=BR-DF-brasilia---&transacao=locacao&precoMax=1200',
  ];
  const itens = new Map();
  for (const b of buscas) {
    for (let p = 1; p <= MAX_PAGINAS; p++) {
      const html = await getText(p > 1 ? `${b}&pagina=${p}` : b);
      const info = extrairJSON(html, (html.indexOf('paginacaoInfoGlobal') + 1) || html.length) || {};
      let novos = 0;
      for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
        let j; try { j = JSON.parse(m[1]); } catch { continue; }
        if (j['@type'] !== 'ItemList') continue;
        for (const e of j.itemListElement || []) { const it = e.item; if (it?.url && !itens.has(it.url)) { itens.set(it.url, it); novos++; } }
      }
      log(`[${site}] ${b.includes('/casa') ? 'casa' : 'apartamento'} página ${p}/${info.TotalPaginas ?? '?'}: +${novos}`);
      if (!novos || !info.TemProximaPagina) break;
      await sleep(400);
    }
  }
  stats[site] = { brutos: itens.size };
  const res = await pool([...itens.values()], 3, async (it) => {
    const off = it.offers || {}; const pl = off.itemOffered || {}; const ad = pl.address || {};
    const titulo = it.name || '';
    const tipo = (titulo.match(/^(\S+)/) || [])[1] || null;
    const bairro = (titulo.match(/em (?:.*, )?([^,]+), Brasília$/) || [])[1] || null;
    let condominio = pl.additionalProperty?.name === 'Condominium Fee' ? pos(pl.additionalProperty.value) : null;
    let iptu = null, dt = null;
    const k = doConhecido(it.url, num(off.price ?? off.priceSpecification?.price));
    if (k) {
      return finalizar({
        site, titulo, tipo, bairro, cidade: [ad.addressLocality, ad.addressRegion].filter(Boolean).join(' - '),
        endereco: [ad.streetAddress, bairro, ad.addressLocality, ad.addressRegion].filter(Boolean).join(', '),
        preco: num(off.price ?? off.priceSpecification?.price), condominio, iptu: null,
        area_m2: pos(pl.floorSize?.value), quartos: pl.numberOfBedrooms ?? null, banheiros: pl.numberOfBathroomsTotal ?? null,
        vagas: num((titulo.match(/(\d+) vagas?/) || [])[1]), data_publicacao: null, data_tipo: null,
        link: it.url, ...k,
      });
    }
    try {
      const html = await getText(it.url);
      dt = (html.match(/"dateModified":"([^"]+)"/) || [])[1] || null;
      const txt = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      iptu = pos((txt.match(/IPTU:?\s*R\$\s*([\d.,]+)/i) || [])[1]);
      condominio = condominio ?? pos((txt.match(/Condom[ií]nio:?\s*R\$\s*([\d.,]+)/i) || [])[1]);
    } catch (e) { log(`[${site}] detalhe falhou: ${e.message}`); }
    return finalizar({
      site, titulo, tipo, bairro, cidade: [ad.addressLocality, ad.addressRegion].filter(Boolean).join(' - '),
      endereco: [ad.streetAddress, bairro, ad.addressLocality, ad.addressRegion].filter(Boolean).join(', '),
      preco: num(off.price ?? off.priceSpecification?.price), condominio, iptu,
      area_m2: pos(pl.floorSize?.value), quartos: pl.numberOfBedrooms ?? null, banheiros: pl.numberOfBathroomsTotal ?? null,
      vagas: num((titulo.match(/(\d+) vagas?/) || [])[1]),
      data_publicacao: isoDe(dt), data_tipo: dt ? 'atualizado' : null,
      link: it.url,
    });
  });
  return res.filter(Boolean);
}

// ---------------- Casa Mineira ----------------
async function casaMineira(browser) {
  const site = 'Casa Mineira';
  const ctx = await browser.newContext({ userAgent: UA, locale: 'pt-BR', viewport: { width: 1366, height: 900 } });
  await ctx.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  const page = await ctx.newPage();
  const brutos = new Map();
  for (const tipoUrl of ['apartamento', 'casa']) {
    let total = null;
    for (let p = 1; p <= MAX_PAGINAS; p++) {
      const url = `https://www.casamineira.com.br/aluguel/${tipoUrl}/df${p > 1 ? '/pagina-' + p : ''}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('[data-qa="POSTING_CARD_PRICE"]', { timeout: 20000 }).catch(() => {});
      const { h1, cards } = await page.evaluate(() => ({
        h1: document.querySelector('h1')?.innerText || '',
        cards: [...document.querySelectorAll('[data-to-posting][data-id]')].map((c) => ({
          id: c.dataset.id,
          href: c.dataset.toPosting,
          preco: c.querySelector('[data-qa="POSTING_CARD_PRICE"]')?.innerText || '',
          exp: c.querySelector('[data-qa="expensas"]')?.innerText || '',
          feats: [...c.querySelectorAll('[data-qa="POSTING_CARD_FEATURES"] span')].map((s) => s.innerText),
          end: c.querySelector('[class*="location-address"]')?.innerText || '',
          loc: c.querySelector('[data-qa="POSTING_CARD_LOCATION"]')?.innerText || '',
          desc: c.querySelector('[data-qa="POSTING_CARD_DESCRIPTION"]')?.innerText || '',
        })),
      }));
      total = total ?? num((h1.match(/^([\d.]+)/) || [])[1]);
      let novos = 0;
      for (const c of cards) if (!brutos.has(c.id)) { brutos.set(c.id, { ...c, tipoUrl }); novos++; }
      log(`[${site}] ${tipoUrl} página ${p}: ${cards.length} cards (+${novos}) de ${total}`);
      if (!novos || cards.length < 20) break;
      await sleep(800);
    }
  }
  stats[site] = { brutos: brutos.size };

  const feat = (arr, re) => { const f = arr.find((s) => re.test(s)); return f ? num(f) : null; };
  const cands = [...brutos.values()].filter((c) => { const p = num(c.preco); return p && p <= FILTRO.precoMax; });
  log(`[${site}] ${cands.length} candidatos <= R$${FILTRO.precoMax}; abrindo páginas dos anúncios`);
  const pages = await Promise.all([0, 1, 2].map(() => ctx.newPage()));
  let pi = 0;
  const res = await pool(cands, 3, async (c) => {
    const link = 'https://www.casamineira.com.br' + c.href.split('?')[0];
    const k = doConhecido(link, num(c.preco));
    if (k) {
      return finalizar({
        site, titulo: (c.desc.split('\n')[0] || c.tipoUrl).slice(0, 200), tipo: c.tipoUrl,
        bairro: c.loc.split(',')[0].trim() || null, cidade: c.loc, endereco: [c.end, c.loc, 'DF'].filter(Boolean).join(', '),
        preco: num(c.preco), condominio: pos((c.exp.match(/R\$\s*([\d.,]+)/) || [])[1]), iptu: null,
        area_m2: feat(c.feats, /m² tot/i) || feat(c.feats, /m²/),
        quartos: feat(c.feats, /quarto/i), banheiros: feat(c.feats, /banh|ban\./i), vagas: feat(c.feats, /vaga/i),
        data_publicacao: null, data_tipo: null, link, ...k,
      });
    }
    const pg = pages[pi++ % pages.length];
    let txt = '';
    for (let t = 1; t <= 3 && !txt; t++) {
      try {
        await pg.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await pg.waitForTimeout(500); // (antes 2,5 s) o conteúdo usado já vem no HTML do servidor
        await pg.waitForLoadState('domcontentloaded');
        txt = await pg.evaluate(() => document.body.innerText);
      } catch (e) { if (t === 3) log(`[${site}] detalhe falhou ${link}: ${e.message}`); else await sleep(1500); }
    }
    const pub = (txt.match(/(Publicado|Atualizado)[^\n]{0,40}/i) || [])[0] || '';
    const cabec = (txt.match(/\n((?:Apartamento|Casa|Cobertura|Kitnet|Studio|Flat|Loft|Sobrado)[^\n]*·[^\n]*)\n/i) || [])[1] || '';
    const descTitulo = (txt.match(/\n([^\n]{15,160}(?:para alugar|para loca[cç][aã]o|R\$[\d.,]+\/m[eê]s)[^\n]*)\n/i) || [])[1] || '';
    const areaTot = feat(c.feats, /m² tot/i), areaUtil = num((txt.match(/([\d.,]+)\s*m² útil/) || [])[1]);
    return finalizar({
      site,
      titulo: (descTitulo || c.desc.split('\n')[0] || cabec).slice(0, 200),
      tipo: (cabec.split('·')[0] || c.tipoUrl).trim() || c.tipoUrl,
      bairro: c.loc.split(',')[0].trim() || null, cidade: c.loc,
      endereco: [c.end, c.loc, 'DF'].filter(Boolean).join(', '),
      preco: num(c.preco),
      condominio: pos((txt.match(/Condom[ií]nio R\$\s*([\d.,]+)/i) || [])[1] || (c.exp.match(/R\$\s*([\d.,]+)/) || [])[1]),
      iptu: pos((txt.match(/IPTU R\$\s*([\d.,]+)/i) || [])[1]),
      area_m2: areaUtil || areaTot || feat(c.feats, /m²/),
      quartos: feat(c.feats, /quarto/i), banheiros: feat(c.feats, /banh|ban\./i), vagas: feat(c.feats, /vaga/i),
      data_publicacao: dataRelativa(pub), data_tipo: /atualiz/i.test(pub) ? 'atualizado' : pub ? 'publicado' : null,
      link,
    });
  });
  await ctx.close();
  return res.filter(Boolean);
}

// ---------------- main ----------------
(async () => {
  const todos = [];
  const rodar = async (nome, fn) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      const ok = r.filter(aprovado);
      stats[nome] = { ...(stats[nome] || {}), candidatos: r.length, aprovados: ok.length, status: 'ok', seg: Math.round((Date.now() - t0) / 1000) };
      todos.push(...ok);
    } catch (e) {
      stats[nome] = { ...(stats[nome] || {}), status: 'falhou: ' + e.message, seg: Math.round((Date.now() - t0) / 1000) };
      log(`[${nome}] FALHOU:`, e.message);
    }
  };
  await rodar('Lugar Certo', lugarCerto);
  await rodar('Loft', loft);
  await rodar('Netimóveis', netimoveis);
  const browser = await chromium.launch({ headless: true });
  try { await rodar('Casa Mineira', () => casaMineira(browser)); } finally { await browser.close(); }

  const vistos = new Set();
  const final = todos.filter((a) => (vistos.has(a.link) ? false : vistos.add(a.link)))
    .sort((a, b) => a.preco - b.preco);
  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'outros.json'), JSON.stringify(final, null, 2));
  console.log('\nResumo por site:');
  console.table(stats);
  if (nConhecidos) console.log(`Conhecidos (sem detalhe): ${nConhecidos}`);
  console.log(`Total salvo em data/outros.json: ${final.length}`);
})();
