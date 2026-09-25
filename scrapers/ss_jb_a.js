// Busca FOCADA em São Sebastião e Jardim Botânico (DF): OLX, DFimóveis e ImovelWeb/Wimoveis.
//
// Usa as buscas POR REGIÃO de cada site (e não a paginação do DF inteiro):
//  - OLX: páginas das RAs (ra-xiv---sao-sebastiao, ra-xxvii---jardim-botanico, ids vindos do
//    location-autocomplete da OLX) e buscas textuais por bairro (q=). A varredura do DF inteiro com
//    pe=<precoMax> (rede de segurança, 0 candidatos novos nas medições) só roda com { amplo: true }
//    ou SSJB_AMPLO=1. Detalhe de cada candidato (sessão nova por anúncio, como em olx.js) traz
//    endereço, CEP, mapLati/mapLong e data original.
//  - DFimóveis: /aluguel/df/sao-sebastiao/imoveis, /aluguel/df/brasilia/{jardim-botanico,
//    jardins-mangueiral,setor-tororo}/imoveis (channel 'chromium' passa no Cloudflare; pausas p/ 429).
//    Página do anúncio tem `latitude = ...; longitude = ...;` (script do mapa).
//  - ImovelWeb (mesmo backend/inventário do Wimoveis, que por isso não é consultado; o link do Wimoveis
//    vai em `link_wimoveis`): API POST /rplis-api/postings com preciomax e city=99983 (São Sebastião),
//    zone=494176 (SH Jardim Botânico), 1557373 (Jardins Mangueiral), 317775 (Tororó). Com amplo, também
//    varre o DF (province=247) para descobrir zonas novas e consulta o Wimoveis. Coordenadas: postingGeolocation.
//
// KNOWN_LINKS_FILE (ver scrapers/known.js): anúncio já conhecido com o mesmo preço não tem o detalhe aberto.
//
// Uso: node scrapers/ss_jb_a.js     -> data_ss/ss_jb_a.json   (SSJB_AMPLO=1 liga as varreduras amplas)
//      const { coletar } = require('./scrapers/ss_jb_a'); await coletar({ precoMax: 1200, amplo: false })

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { passaFiltro } = require('./common');
const { reaproveitar } = require('./known');

const OUT = path.join(__dirname, '..', 'data_ss', 'ss_jb_a.json');
const TERMINAL_SS = { lat: -15.9133454, lon: -47.7573464 };
// Caixa que cobre São Sebastião + Jardim Botânico (coordenadas fora disso são descartadas).
const BBOX = { latMin: -16.10, latMax: -15.82, lonMin: -47.87, lonMax: -47.55 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const isoDia = (d) => new Date(d).toISOString().slice(0, 10);
function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/\s/g, '').match(/\d[\d.]*(,\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function diasAtras(n) { const d = new Date(); d.setDate(d.getDate() - n); return isoDia(d); }
function dataRelativa(txt) {
  const t = norm(txt);
  if (!t) return null;
  if (/hoje|hora|minuto|segundo/.test(t)) return diasAtras(0);
  if (/ontem/.test(t)) return diasAtras(1);
  let m = t.match(/(\d+)\s*dias?/); if (m) return diasAtras(+m[1]);
  m = t.match(/(\d+)\s*semanas?/); if (m) return diasAtras(7 * m[1]);
  m = t.match(/(\d+)\s*(mes|meses)/); if (m) return diasAtras(30 * m[1]);
  if (/um mes/.test(t)) return diasAtras(30);
  m = t.match(/(\d+)\s*anos?/); if (m) return diasAtras(365 * m[1]);
  if (/um ano/.test(t)) return diasAtras(365);
  return null;
}
function dataBr(s) {
  const m = (s || '').match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
  if (!m) return null;
  return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2]}-${m[1]}`;
}
function distKm(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function setGeo(a, lat, lon, fonte) {
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return;
  if (lat < BBOX.latMin || lat > BBOX.latMax || lon < BBOX.lonMin || lon > BBOX.lonMax) {
    a.geo_fonte = `${fonte} (descartada: fora da região ${lat.toFixed(4)},${lon.toFixed(4)})`;
    return;
  }
  a.lat = lat; a.lon = lon; a.geo_fonte = fonte;
}

// Anúncio conhecido (KNOWN_LINKS_FILE, mesmo preço): copia os campos e revalida a coordenada na caixa.
function usarConhecido(a) {
  if (!reaproveitar(a)) return false;
  if (a.lat != null && a.lon != null) { const [la, lo] = [a.lat, a.lon]; a.lat = null; a.lon = null; setGeo(a, la, lo, 'execução anterior (KNOWN_LINKS_FILE)'); }
  return true;
}

// ---------- Região ----------
const RE_JB = /jardim botanico|mangueiral|tororo|sao bartolomeu \(jardim|setor habitacional sao bartolomeu/;
const RE_SS = /sao sebastiao/;
const RE_MUNICIPIO_FORA = /luziania|valparaiso|cidade ocidental|novo gama|formosa|aguas lindas|planaltina de goias|cristalina|unai|goiania/;
// Retorna 'São Sebastião' | 'Jardim Botânico' | null.
function regiaoDe({ bairro, cidade, endereco, titulo, municipio }) {
  if (RE_MUNICIPIO_FORA.test(norm(municipio)) || RE_MUNICIPIO_FORA.test(norm(cidade))) return null;
  const b = norm(bairro), c = norm(cidade), e = norm(endereco);
  if (/alto mangueiral/.test(b) || (!b && /alto mangueiral/.test(e))) return 'São Sebastião'; // Alto Mangueiral fica na RA de São Sebastião
  if (RE_JB.test(b) || RE_JB.test(c)) return 'Jardim Botânico';
  if (RE_SS.test(b) || RE_SS.test(c)) return 'São Sebastião';
  if (RE_JB.test(e)) return 'Jardim Botânico';
  if (RE_SS.test(e)) return 'São Sebastião';
  // Último recurso: título (só quando a localização não aponta para outra RA conhecida)
  const t = norm(titulo);
  if (!b && !c) {
    if (RE_JB.test(t)) return 'Jardim Botânico';
    if (RE_SS.test(t)) return 'São Sebastião';
  }
  return null;
}

// ---------- Exclusões extras ----------
const RE_EXCLUI = /kit ?net|kitinete|quitinete|kitchenette|\bkit\b|studio|st[uú]dio|est[uú]dio|loft|quarto avulso|aluguel de quartos?|(aluga|alugo|aluga-se)( um)? quarto\b(?! e)|quarto (individual|mobiliad|para (homem|homens|mulher|rapaz|mo[cç]a|estudante)|em casa)|vaga (em|para)|compartilhad|\bdividir\b|sala comercial|ponto comercial|\bloja\b|galp[aã]o|temporada|di[aá]ria|por dia\b|\bvenda\b|vendo\b/i;
function excluido(a, extra = '') {
  return RE_EXCLUI.test(a.titulo || '') || RE_EXCLUI.test(extra);
}
function sanitiza(a) {
  if (a.area_m2 != null && (a.area_m2 > 1000 || a.area_m2 <= 0)) a.area_m2 = null;
  if (a.quartos != null && a.quartos > 20) a.quartos = null;
  if (a.banheiros != null && a.banheiros > 20) a.banheiros = null;
  return a;
}
function aprovado(a, extra) {
  sanitiza(a);
  return !!a.regiao && ['apartamento', 'casa', 'casa em condomínio'].includes(a.tipo) && !excluido(a, extra) && passaFiltro(a);
}

function novoAnuncio(o) {
  return {
    site: null, titulo: null, tipo: null, regiao: null, bairro: null, endereco: null, cep: null,
    lat: null, lon: null, preco: null, condominio: null, iptu: null, area_m2: null, quartos: null,
    banheiros: null, vagas: null, data_publicacao: null, data_tipo: null, link: null, id_site: null,
    coletado_em: new Date().toISOString(), ...o,
  };
}

async function novoContexto(browser, ua, bloquearMidia = true) {
  const ctx = await browser.newContext({
    userAgent: ua, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en'] });
    window.chrome = window.chrome || { runtime: {} };
  });
  if (bloquearMidia) {
    await ctx.route('**/*', (route) => (['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
  }
  return ctx;
}

async function comConcorrencia(itens, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => {
    while (i < itens.length) { const k = i++; await fn(itens[k], k); }
  }));
}

// =====================================================================================
// OLX
// =====================================================================================
const OLX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function olxExtrairAds(html) {
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let full = '', m;
  while ((m = re.exec(html))) { try { full += JSON.parse(m[1]); } catch (_) { /* ignore */ } }
  const idx = full.indexOf('"ads":[');
  if (idx < 0) return { ads: [], total: null };
  const start = idx + 6;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < full.length; i++) {
    const c = full[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  let ads = [];
  if (end > 0) { try { ads = JSON.parse(full.slice(start, end + 1)); } catch (_) { /* ignore */ } }
  const t = full.match(/"totalOfAds":(\d+)/);
  return { ads, total: t ? Number(t[1]) : null };
}
const propsMap = (props) => Object.fromEntries((props || []).map((p) => [p.name, p.value]));

function olxTipo(catTipo, p) {
  const t = norm(`${p.re_types || ''} ${p.real_estate_type || ''} ${p.category || ''}`);
  if (/kit|studio|loft|quarto/.test(norm(p.re_types))) return 'kitnet';
  if (/condominio/.test(t)) return 'casa em condomínio';
  if (/casa/.test(t)) return 'casa';
  if (/apartamento|cobertura|duplex|triplex/.test(t)) return 'apartamento';
  return catTipo;
}

function olxDaListagem(ad, catTipo) {
  const p = propsMap(ad.properties);
  const loc = ad.locationDetails || {};
  const bairro = loc.neighbourhood || (ad.location || '').split(',').slice(1).join(',').trim() || null;
  const municipio = loc.municipality || (ad.location || '').split(',')[0].trim() || null;
  const a = novoAnuncio({
    site: 'OLX', titulo: ad.subject || null, tipo: olxTipo(catTipo, p), bairro,
    preco: num(ad.priceValue || ad.price), condominio: num(p.condominio), iptu: num(p.iptu),
    area_m2: num(p.size), quartos: num(p.rooms), banheiros: num(p.bathrooms), vagas: num(p.garage_spaces),
    data_publicacao: ad.date ? isoDia(ad.date * 1000) : null, data_tipo: ad.date ? 'atualizado' : null,
    link: String(ad.url).split('?')[0], id_site: String(ad.listId),
  });
  a._municipio = municipio;
  a._extra = `${p.re_types || ''} ${ad.categoryName || ''}`;
  a.regiao = regiaoDe({ bairro, cidade: null, municipio, titulo: a.titulo });
  return a;
}

async function olxAbrir(page, url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const st = r ? r.status() : 0;
      if (st === 403 || /just a moment|captcha/i.test(await page.title())) { await sleep(rand(4000, 8000)); continue; }
      return await page.content();
    } catch (e) { await sleep(rand(2000, 4000)); }
  }
  return null;
}

async function olxDetalhe(browser, a, st) {
  let html = null;
  for (let t = 0; t < 3 && !html; t++) {
    const ctx = await novoContexto(browser, OLX_UA);
    const page = await ctx.newPage();
    try {
      const r = await page.goto(a.link, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (r && r.status() < 400 && !/just a moment|captcha/i.test(await page.title())) html = await page.content();
    } catch (_) { /* retry */ }
    await ctx.close().catch(() => {});
    if (!html) { st.det403++; await sleep(rand(4000, 9000)); }
  }
  if (!html) return false;
  const m = html.match(/<script id="initial-data"[^>]*data-json="([^"]*)"/);
  if (!m) return false;
  let d;
  try { d = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&')); } catch (_) { return false; }
  const ad = d.ad || d;
  const loc = ad.location || {};
  if (loc.neighbourhood) a.bairro = loc.neighbourhood;
  if (loc.municipality) a._municipio = loc.municipality;
  a.endereco = [loc.address, loc.neighbourhood, loc.municipality, loc.uf].filter(Boolean).join(', ') || null;
  if (loc.zipcode) a.cep = String(loc.zipcode).replace(/^(\d{5})(\d{3})$/, '$1-$2');
  if (loc.mapLati != null && loc.mapLong != null) setGeo(a, loc.mapLati, loc.mapLong, 'OLX mapLati/mapLong');
  if (ad.origListTime) { a.data_publicacao = isoDia(ad.origListTime * 1000); a.data_tipo = 'publicado'; }
  else if (ad.listTime) { a.data_publicacao = isoDia(ad.listTime); a.data_tipo = 'atualizado'; }
  const p = propsMap(ad.properties);
  if (a.area_m2 == null) a.area_m2 = num(p.size);
  if (a.quartos == null) a.quartos = num(p.rooms);
  if (a.banheiros == null) a.banheiros = num(p.bathrooms);
  if (a.vagas == null) a.vagas = num(p.garage_spaces);
  for (const pr of ad.realEstatePriceInfo || []) {
    const v = num(pr.value);
    if (pr.name === 'condominio' && a.condominio == null && v) a.condominio = v;
    if (pr.name === 'iptu' && a.iptu == null && v) a.iptu = v;
  }
  if (p.re_types) { a._extra += ' ' + p.re_types; a.tipo = olxTipo(a.tipo, p) === 'kitnet' ? 'kitnet' : a.tipo; }
  a.regiao = regiaoDe({ bairro: a.bairro, municipio: a._municipio, endereco: a.endereco, titulo: a.titulo });
  return true;
}

async function coletarOlx(precoMax, log, amplo = false) {
  const st = { paginas: 0, brutos: 0, det403: 0, bloqueios: [] };
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const cands = new Map();
  try {
    const ctx = await novoContexto(browser, OLX_UA);
    const page = await ctx.newPage();
    const base = 'https://www.olx.com.br/imoveis/aluguel';
    const buscas = [];
    for (const [cat, tipo] of [['apartamentos', 'apartamento'], ['casas', 'casa']]) {
      for (const ra of ['ra-xiv---sao-sebastiao', 'ra-xxvii---jardim-botanico']) {
        buscas.push({ nome: `${cat}/${ra}`, tipo, url: `${base}/${cat}/estado-df/distrito-federal-e-regiao/brasilia/${ra}?pe=${precoMax}`, max: 10 });
      }
      for (const q of ['são sebastião', 'mangueiral', 'jardim botânico', 'tororó', 'são bartolomeu']) {
        buscas.push({ nome: `${cat}/q=${q}`, tipo, url: `${base}/${cat}/estado-df?pe=${precoMax}&q=${encodeURIComponent(q)}`, max: 5 });
      }
      // Rede de segurança (só com amplo): DF inteiro até precoMax, filtrado pelo bairro.
      if (amplo) buscas.push({ nome: `${cat}/DF`, tipo, url: `${base}/${cat}/estado-df?pe=${precoMax}`, max: 40 });
    }
    for (const b of buscas) {
      let achados = 0, total = null;
      for (let pg = 1; pg <= b.max; pg++) {
        const html = await olxAbrir(page, b.url + `&o=${pg}`);
        if (!html) { st.bloqueios.push(`OLX listagem bloqueada: ${b.nome} p${pg}`); break; }
        st.paginas++;
        const r = olxExtrairAds(html);
        total = r.total;
        const ads = r.ads.filter((x) => x && x.listId && x.url);
        if (!ads.length) break;
        st.brutos += ads.length;
        for (const ad of ads) {
          const a = olxDaListagem(ad, b.tipo);
          if (!a.regiao || cands.has(a.link)) continue;
          if (a.tipo === 'kitnet' || excluido(a, a._extra) || !passaFiltro(sanitiza(a))) continue;
          cands.set(a.link, a); achados++;
        }
        if (total != null && pg * 50 >= total) break;
        await sleep(rand(1000, 2200));
      }
      log(`  OLX ${b.nome}: total=${total} -> ${achados} candidatos novos`);
    }
    await ctx.close();

    const todosCands = [...cands.values()];
    const lista = [];
    for (const a of todosCands) {
      if (usarConhecido(a)) a.regiao = regiaoDe({ bairro: a.bairro, municipio: a._municipio, endereco: a.endereco, titulo: a.titulo });
      else lista.push(a);
    }
    log(`  OLX: ${todosCands.length} candidatos (${todosCands.length - lista.length} conhecidos); buscando ${lista.length} detalhes...`);
    let ok = 0;
    await comConcorrencia(lista, 4, async (a) => {
      if (await olxDetalhe(browser, a, st)) ok++;
      await sleep(rand(700, 1800));
    });
    log(`  OLX detalhes ok ${ok}/${lista.length} (tentativas bloqueadas: ${st.det403})`);
    if (ok < lista.length) st.bloqueios.push(`OLX: ${lista.length - ok} detalhes não carregaram`);
  } catch (e) {
    st.bloqueios.push(`OLX erro: ${e.message.split('\n')[0]}`);
  } finally {
    await browser.close().catch(() => {});
  }
  const final = [...cands.values()].filter((a) => aprovado(a, a._extra));
  return { anuncios: final, st };
}

// =====================================================================================
// DFimóveis
// =====================================================================================
const DFI = 'https://www.dfimoveis.com.br';

async function dfiAbrir(page, url) {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      let ok = false;
      for (let k = 0; k < 20; k++) {
        if (!/just a moment|um momento|attention required/i.test(await page.title().catch(() => ''))) { ok = true; break; }
        await page.waitForTimeout(1500);
      }
      if (ok && r && r.status() < 400) return true;
      if (ok && r && r.status() === 404) return false;
    } catch (_) { /* retry */ }
    await sleep(12000 * i + rand(0, 4000)); // 429: recua
  }
  return false;
}

function dfiCards() {
  return [...document.querySelectorAll('article a.imovel-card[href^="/imovel/"]')].map((a) => {
    const txt = (sel) => (a.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
    const desc = txt('p[itemprop=description]');
    return {
      href: a.getAttribute('href'), local: txt('h2[itemprop=name]'), h3: txt('h3'), subtitulo: txt('p.web-ellipse-view'),
      preco: a.querySelector('[itemprop=price]')?.getAttribute('content') || txt('.imovel-price strong'),
      pills: [...a.querySelectorAll('.imovel-feature > div')].map((d) => d.textContent.replace(/\s+/g, ' ').trim()),
      dataCard: (desc.match(/(\d{2}\/\d{2}\/\d{2,4})\s*$/) || [])[1] || null,
    };
  });
}

function dfiTipo(slug) {
  if (/^casa-condominio|^casa-em-condominio/.test(slug)) return 'casa em condomínio';
  const t = slug.split('-')[0];
  if (t === 'apartamento' || t === 'cobertura') return 'apartamento';
  if (t === 'casa' || t === 'sobrado') return 'casa';
  return t; // kitnet, loja, lote, sala... (descartados)
}

function dfiDoCard(c) {
  const slug = c.href.split('/').pop();
  const pill = (re) => { const p = c.pills.find((x) => re.test(x)); return p ? num(p) : null; };
  const partes = c.local.split(',').map((s) => s.trim()).filter(Boolean);
  const cidade = partes.length >= 2 ? partes[partes.length - 1] : null;
  const bairro = partes.length >= 2 ? partes[partes.length - 2] : partes[0] || null;
  const endereco = partes.length >= 3 ? partes.slice(0, -2).join(', ') : null;
  const a = novoAnuncio({
    site: 'DFimóveis', titulo: (c.subtitulo || '').replace(/^[,\s-]+/, '') || c.h3 || slug, tipo: dfiTipo(slug),
    bairro, endereco: [endereco, bairro, cidade].filter(Boolean).join(', ') || null,
    preco: num(c.preco), area_m2: pill(/m²/), quartos: pill(/quarto/i), vagas: pill(/vaga/i),
    data_publicacao: dataBr(c.dataCard), data_tipo: c.dataCard ? 'publicado' : null,
    link: DFI + c.href, id_site: (slug.match(/(\d+)$/) || [])[1] || null,
  });
  a._cidade = cidade; a._slug = slug; a._rua = endereco;
  a.regiao = regiaoDe({ bairro, cidade, titulo: a.titulo });
  return a;
}

async function dfiDetalhe(page, a) {
  if (!(await dfiAbrir(page, a.link))) return false;
  const d = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const main = document.querySelector('main') || document.body;
    let t = main.innerText;
    const corte = t.search(/Buscar em outras cidades|DFIMOVEIS\.COM\n/);
    if (corte > 0) t = t.slice(0, corte);
    const campo = (re) => (t.match(re) || [])[1] || null;
    const geo = html.match(/latitude\s*=\s*(-?\d+(?:\.\d+)?)\s*;\s*longitude\s*=\s*(-?\d+(?:\.\d+)?)/);
    let filtro = null;
    const mf = html.match(/window\.imovelFiltro\s*=\s*(\{[^;]*\});/);
    if (mf) { try { filtro = JSON.parse(mf[1]); } catch (_) { /* ignore */ } }
    return {
      h1: document.querySelector('h1')?.innerText?.trim() || null,
      area: campo(/[ÁA]rea\s*[ÚU]til:?\s*([\d.,]+)\s*m²/i) || campo(/[ÁA]rea\s*Total:?\s*([\d.,]+)\s*m²/i),
      condominio: campo(/Condom[íi]nio\s*(?:R\$)?:?\s*R?\$?\s*([\d.,]+)/i),
      iptu: campo(/IPTU\s*R\$:?\s*([\d.,]+)/i),
      banheiros: campo(/\b(\d{1,2})\s*(?:banheiros?|wcs?\b)/i) || campo(/banheiros?\s*:?\s*(\d{1,2})\b/i)
        || ({ dois: '2', duas: '2', tres: '3', 'três': '3' }[((t.match(/\b(dois|duas|tr[eê]s)\s+banheiros/i) || [])[1] || '').toLowerCase()])
        || (/banheiro|\bwc\b|su[íi]te/i.test(t) ? '1' : null),
      quartos: campo(/(\d+)\s*quartos?/i),
      vagas: campo(/(\d+)\s*vagas?/i),
      cep: campo(/CEP:?\s*(\d{5}-?\d{3})/i),
      publicadoHa: campo(/Publicado h[áa]:?\s*([^\n]+)/i),
      atualizado: campo(/Atualizado em:?\s*(\d{2}\/\d{2}\/\d{2,4})/i),
      lat: geo ? geo[1] : null, lon: geo ? geo[2] : null, filtro,
      desc: t.slice(0, 4000),
    };
  });
  if (a.area_m2 == null && d.area) a.area_m2 = num(d.area);
  a.condominio = d.condominio ? num(d.condominio) : a.condominio;
  a.iptu = d.iptu ? num(d.iptu) : a.iptu;
  if (d.banheiros) a.banheiros = num(d.banheiros);
  if (a.quartos == null && d.quartos) a.quartos = num(d.quartos);
  if (a.vagas == null && d.vagas) a.vagas = num(d.vagas);
  if (d.cep) a.cep = d.cep.replace(/^(\d{5})(\d{3})$/, '$1-$2');
  if (d.h1 && !a._rua) a.endereco = [d.h1, a.bairro, a._cidade].filter(Boolean).join(', ');
  if (d.lat && d.lon) setGeo(a, d.lat, d.lon, 'DFimóveis mapa da página');
  if (d.filtro) {
    if (d.filtro.Bairro) a.bairro = d.filtro.Bairro;
    if (d.filtro.Cidade) a._cidade = d.filtro.Cidade;
    const tp = norm(`${d.filtro.Tipo} ${d.filtro.Subtipo}`);
    if (/kit|studio|loft|flat/.test(tp)) a.tipo = 'kitnet';
    else if (/condominio/.test(tp) && /casa/.test(tp)) a.tipo = 'casa em condomínio';
  }
  const atual = d.atualizado ? dataBr(d.atualizado) : dataRelativa(d.publicadoHa);
  if (!a.data_publicacao && atual) { a.data_publicacao = atual; a.data_tipo = 'atualizado'; }
  a.regiao = regiaoDe({ bairro: a.bairro, cidade: a._cidade, endereco: a.endereco, titulo: a.titulo }) || a.regiao;
  return true;
}

async function coletarDfimoveis(precoMax, log) {
  const st = { paginas: 0, brutos: 0, bloqueios: [] };
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-blink-features=AutomationControlled'] });
  const cands = new Map();
  try {
    const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
    const ctx = await novoContexto(browser, ua);
    const page = await ctx.newPage();
    const locais = ['sao-sebastiao', 'jardim-botanico', 'brasilia/jardim-botanico', 'brasilia/jardins-mangueiral', 'brasilia/setor-tororo', 'brasilia/altiplano-leste'];
    for (const loc of locais) {
      let achados = 0, h1 = '';
      for (let pg = 1; pg <= 30; pg++) {
        const url = `${DFI}/aluguel/df/${loc}/imoveis?valorfinal=${precoMax}${pg > 1 ? `&pagina=${pg}` : ''}`;
        if (!(await dfiAbrir(page, url))) { if (pg === 1) st.bloqueios.push(`DFimóveis: falhou ${url}`); break; }
        st.paginas++;
        if (pg === 1) h1 = await page.evaluate(() => document.querySelector('h1')?.innerText || '');
        const cards = await page.evaluate(dfiCards);
        let novos = 0;
        for (const c of cards) {
          const a = dfiDoCard(c);
          st.brutos++;
          if (cands.has(a.link)) continue;
          novos++;
          if (!a.regiao) continue;
          if (/^(kitnet|studio|quarto|loft|flat|hotel|loja|sala|lote|galpao|garagem|predio|ponto|rural)/i.test(a._slug)) continue;
          if (excluido(a) || !passaFiltro(sanitiza(a))) continue;
          cands.set(a.link, a); achados++;
        }
        if (!cards.length || !novos) break;
        await sleep(rand(1500, 3000));
      }
      log(`  DFimóveis ${loc}: "${h1.split('\n')[0]}" -> ${achados} candidatos`);
      await sleep(rand(1500, 3000));
    }
    const todosCands = [...cands.values()];
    const lista = todosCands.filter((a) => !usarConhecido(a));
    log(`  DFimóveis: ${todosCands.length} candidatos (${todosCands.length - lista.length} conhecidos); buscando ${lista.length} detalhes...`);
    let ok = 0;
    await comConcorrencia(lista, 2, async (a) => {
      const p = await ctx.newPage();
      if (await dfiDetalhe(p, a)) ok++;
      await p.close();
      await sleep(rand(3000, 5500)); // DFimóveis devolve 429: mantém a pausa
    });
    log(`  DFimóveis detalhes ok ${ok}/${lista.length}`);
    if (ok < lista.length) st.bloqueios.push(`DFimóveis: ${lista.length - ok} detalhes não carregaram (429/Cloudflare)`);
  } catch (e) {
    st.bloqueios.push(`DFimóveis erro: ${e.message.split('\n')[0]}`);
  } finally {
    await browser.close().catch(() => {});
  }
  const final = [...cands.values()].filter((a) => aprovado(a));
  return { anuncios: final, st };
}

// =====================================================================================
// ImovelWeb / Wimoveis (plataforma Navent, mesmo inventário)
// =====================================================================================
const IW_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const IW_SITES = [
  { site: 'ImovelWeb', base: 'https://www.imovelweb.com.br', pagina: '/imoveis-aluguel-sao-sebastiao-df.html' },
  { site: 'Wimoveis', base: 'https://www.wimoveis.com.br', pagina: '/aluguel/imoveis/df' },
];
// ids de localização (Navent): cidade São Sebastião e zonas de Brasília no Jardim Botânico
const IW_LOCAIS = [
  { nome: 'São Sebastião (cidade)', filtro: { city: '99983' } },
  { nome: 'SH Jardim Botânico', filtro: { zone: '494176' } },
  { nome: 'SH Jardins Mangueiral', filtro: { zone: '1557373' } },
  { nome: 'SH Tororó', filtro: { zone: '317775' } },
];
const decode = (s) => { let t = String(s || ''); for (let i = 0; i < 2; i++) t = t.replace(/&amp;/g, '&'); return t.replace(/&ordm;/g, 'º').replace(/&ordf;/g, 'ª').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)); };

function iwTipo(raw) {
  const t = norm(raw);
  if (/kit|studio|quarto|comerc|terreno|lote|sala|loja|galp|predio|rural|chacara|fazenda|garagem|box|deposito|flat|loft/.test(t)) return 'outro';
  if (/condominio/.test(t) && /casa/.test(t)) return 'casa em condomínio';
  if (/casa|sobrado/.test(t)) return 'casa';
  if (/apartamento|cobertura|duplex|triplex/.test(t)) return 'apartamento';
  return 'outro';
}

function iwMap(p, cfg) {
  const feat = p.mainFeatures || {};
  const fv = (id) => (feat[id] ? num(feat[id].value) : null);
  const op = (p.priceOperationTypes || []).find((o) => /alug/i.test(o.operationType?.name || '')) || (p.priceOperationTypes || [])[0];
  const loc = p.postingLocation || {};
  const l = loc.location || {};
  const zona = l.label === 'ZONA' ? l.name : null;
  const cidade = l.label === 'ZONA' ? l.parent?.name : l.name;
  const rua = decode(loc.address?.name || '').trim() || null;
  const tipoRaw = p.realEstateType?.name || '';
  const a = novoAnuncio({
    site: cfg.site, titulo: decode(p.title || p.generatedTitle || '').trim(), tipo: iwTipo(tipoRaw),
    bairro: zona || cidade || null, endereco: [rua, zona, cidade].filter(Boolean).join(', ') || null,
    preco: op?.prices?.[0]?.amount != null ? Number(op.prices[0].amount) : null,
    condominio: p.expenses?.amount ? Number(p.expenses.amount) : null,
    iptu: p.iptu?.amount ? Number(p.iptu.amount) : (typeof p.iptu === 'number' && p.iptu > 0 ? p.iptu : null),
    area_m2: fv('CFT101') ?? fv('CFT100'), quartos: fv('CFT2'), banheiros: fv('CFT3'), vagas: fv('CFT7'),
    link: new URL(p.url, cfg.base).href.split('?')[0], id_site: String(p.postingId),
  });
  const g = loc.postingGeolocation?.geolocation;
  if (g && g.latitude != null) setGeo(a, g.latitude, g.longitude, `${cfg.site} postingGeolocation`);
  a._tipoRaw = tipoRaw;
  a.regiao = regiaoDe({ bairro: zona, cidade, endereco: rua, titulo: a.titulo });
  return a;
}

async function coletarImovelweb(precoMax, log, amplo = false) {
  const st = { paginas: 0, brutos: 0, bloqueios: [] };
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const porId = new Map();
  try {
    // Mesmo inventário nos dois portais: sem amplo, só o ImovelWeb.
    for (const cfg of amplo ? IW_SITES : IW_SITES.slice(0, 1)) {
      const ctx = await novoContexto(browser, IW_UA, false);
      const page = await ctx.newPage();
      try {
        await page.goto(cfg.base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(rand(1200, 2000));
        await page.goto(cfg.base + cfg.pagina, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(rand(1200, 2000));
        if (/just a moment|attention required/i.test(await page.title())) { st.bloqueios.push(`${cfg.site}: Cloudflare`); continue; }
        const api = (body) => page.evaluate(async (b) => {
          const r = await fetch('/rplis-api/postings', { method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' }, body: JSON.stringify(b) });
          const t = await r.text();
          try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, json: null }; }
        }, body);
        const base = { q: null, moneda: '3', tipoDeOperacion: '2', sort: 'relevance', tipoAnunciante: 'ALL' };
        const varrer = async (nome, filtro, maxPag) => {
          let novos = 0, total = null;
          const ids = new Set();
          // 'relevance' pode embaralhar entre páginas; se faltar id em relação ao total, 2ª passada por data.
          for (const sort of ['relevance', 'more_recent']) {
            if (sort !== 'relevance' && (total == null || ids.size >= total)) break;
            for (let pagina = 1; pagina <= maxPag; pagina++) {
              let r = await api({ ...base, sort, ...filtro, pagina });
              if (r.status !== 200 || !r.json) { await sleep(rand(6000, 9000)); r = await api({ ...base, sort, ...filtro, pagina }); }
              if (r.status !== 200 || !r.json) { st.bloqueios.push(`${cfg.site}: API HTTP ${r.status} em ${nome} p${pagina}`); break; }
              st.paginas++;
              const list = r.json.listPostings || [];
              if (sort === 'relevance') total = r.json.paging?.total;
              for (const p of list) {
                st.brutos++;
                ids.add(String(p.postingId));
                const a = iwMap(p, cfg);
                if (!a.regiao) continue;
                if (!porId.has(a.id_site)) { porId.set(a.id_site, a); novos++; }
              }
              if (!list.length || r.json.paging?.lastPage || pagina >= (r.json.paging?.totalPages || 0)) break;
              await sleep(rand(600, 1250));
            }
          }
          log(`  ${cfg.site} ${nome}: total=${total} -> ${novos} novos da região`);
        };
        // Filtro de preço na própria busca: só vêm anúncios <= precoMax (os demais seriam descartados).
        for (const l of IW_LOCAIS) await varrer(l.nome, { ...l.filtro, preciomax: precoMax }, 30);
        // descoberta (só com amplo): DF inteiro até precoMax (pega zonas da região com outros ids)
        if (amplo) await varrer(`DF<=${precoMax}`, { province: '247', preciomax: precoMax }, 40);

        // Datas (só dos aprovados deste site)
        const lote = [...porId.values()].filter((a) => a.site === cfg.site && !a.data_publicacao && aprovado(a, a._tipoRaw) && !usarConhecido(a));
        for (const a of lote) {
          try {
            const html = await page.evaluate(async (u) => { const r = await fetch(u, { credentials: 'include' }); return r.status === 200 ? r.text() : ''; }, a.link);
            const txt = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
            const m = txt.match(/(Publicado|Atualizado)\s+(h[aá]\s+(mais de\s+)?\d+\s+\w+|h[aá]\s+(um|uma)\s+\w+|desde\s+\w+|hoje|ontem)/i);
            if (m) { a.data_publicacao = dataRelativa(m[2]); a.data_tipo = /atualiz/i.test(m[1]) ? 'atualizado' : 'publicado'; }
            const cep = txt.match(/CEP:?\s*(\d{5}-?\d{3})/i);
            if (cep) a.cep = cep[1].replace(/^(\d{5})(\d{3})$/, '$1-$2');
          } catch (_) { /* ignore */ }
          await sleep(rand(350, 800));
        }
      } catch (e) {
        st.bloqueios.push(`${cfg.site} erro: ${e.message.split('\n')[0]}`);
      } finally {
        await ctx.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const final = [...porId.values()].filter((a) => aprovado(a, a._tipoRaw));
  for (const a of final) if (a.site === 'ImovelWeb') a.link_wimoveis = IW_SITES[1].base + new URL(a.link).pathname; // mesmo anúncio
  return { anuncios: final, st };
}

// =====================================================================================
async function coletar({ precoMax = 1200, log = (m) => console.log(m), amplo = process.env.SSJB_AMPLO === '1' } = {}) {
  const t0 = Date.now();
  log(`[ss_jb_a] coletando São Sebastião + Jardim Botânico (até R$ ${precoMax})${amplo ? ' [amplo]' : ''}...`);
  const fontes = [['OLX', coletarOlx], ['DFimóveis', coletarDfimoveis], ['ImovelWeb', coletarImovelweb]];
  const res = await Promise.allSettled(fontes.map(([, fn]) => fn(precoMax, log, amplo)));
  const todos = [];
  const bloqueios = [];
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      todos.push(...r.value.anuncios);
      bloqueios.push(...r.value.st.bloqueios);
      log(`[ss_jb_a] ${fontes[i][0]}: ${r.value.anuncios.length} aprovados (páginas ${r.value.st.paginas}, brutos ${r.value.st.brutos})`);
    } else {
      bloqueios.push(`${fontes[i][0]} falhou: ${r.reason && r.reason.message}`);
    }
  });
  // Dedup por link e limpeza
  const vistos = new Set();
  const final = [];
  for (const a of todos) {
    const link = a.link.split('?')[0];
    if (vistos.has(link)) continue;
    vistos.add(link);
    const o = {};
    for (const k of Object.keys(a)) if (!k.startsWith('_')) o[k] = a[k];
    o.link = link;
    o.dist_terminal_ss_km = o.lat != null ? Math.round(distKm(TERMINAL_SS, o) * 100) / 100 : null;
    final.push(o);
  }
  final.sort((x, y) => (x.regiao || '').localeCompare(y.regiao || '') || (x.dist_terminal_ss_km ?? 99) - (y.dist_terminal_ss_km ?? 99) || x.preco - y.preco);
  if (bloqueios.length) log(`[ss_jb_a] ocorrências: ${bloqueios.join(' | ')}`);
  log(`[ss_jb_a] ${final.length} anúncios em ${Math.round((Date.now() - t0) / 1000)}s`);
  coletar.ultimasOcorrencias = bloqueios;
  return final;
}

module.exports = { coletar, regiaoDe };

if (require.main === module) {
  coletar().then((lista) => {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(lista, null, 2));
    console.log(`[ss_jb_a] salvo em ${OUT}`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
