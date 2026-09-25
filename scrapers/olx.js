// Crawler OLX (df.olx.com.br) - aluguel de apartamentos e casas no DF, até R$ 1.200.
// Estratégia: Playwright abre as páginas de listagem (filtros na URL: categoria, estado DF, pe=1200, o=página),
// extrai o array "ads" do payload RSC do Next.js (self.__next_f), filtra por região/filtro e depois visita
// cada anúncio candidato (concorrência 4) para pegar endereço, data de publicação original e campos faltantes.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { regiaoPermitida, passaFiltro } = require('./common');
const { reaproveitar } = require('./known');

const MAX_PAGES = 25; // ~1000 aptos <= R$1200 no DF => ~21 páginas de 50
const CONCURRENCY = 4;
const CATEGORIAS = [
  { tipo: 'apartamento', path: 'apartamentos' },
  { tipo: 'casa', path: 'casas' },
];
// UA coerente com o navegador e o SO reais (mesma versão do sec-ch-ua, sem "HeadlessChrome"). Um UA de Mac/Chrome 128
// fixo num Chromium 15x rodando em Linux é o que fazia o Cloudflare da OLX bloquear o runner do GitHub Actions.
function uaCoerente(browser) {
  const plat = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${plat}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split('.')[0]}.0.0.0 Safari/537.36`;
}
const OUT = path.join(__dirname, '..', 'data', 'olx.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => sleep(a + Math.random() * (b - a));

const num = (s) => {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const m = String(s).replace(/\./g, '').replace(',', '.').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// Extrai o texto concatenado do payload RSC (self.__next_f.push([1,"..."])) e localiza o array "ads".
function extractAds(html) {
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let full = '';
  let m;
  while ((m = re.exec(html))) {
    try { full += JSON.parse(m[1]); } catch (_) { /* ignore */ }
  }
  const idx = full.indexOf('"ads":[');
  if (idx < 0) return { ads: [], total: null };
  const start = idx + 6;
  // casamento de colchetes respeitando strings
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < full.length; i++) {
    const c = full[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return { ads: [], total: null };
  let ads = [];
  try { ads = JSON.parse(full.slice(start, end + 1)); } catch (e) { console.error('parse ads falhou', e.message); }
  const t = full.match(/"totalOfAds":(\d+)/);
  return { ads, total: t ? Number(t[1]) : null };
}

function propsMap(props) {
  const o = {};
  for (const p of props || []) o[p.name] = p.value;
  return o;
}

function fromListing(ad, tipoCat) {
  const p = propsMap(ad.properties);
  const loc = ad.locationDetails || {};
  const bairro = loc.neighbourhood || (ad.location || '').split(',').slice(1).join(',').trim() || null;
  const cidade = loc.municipality || (ad.location || '').split(',')[0].trim() || null;
  const tipoTxt = (p.real_estate_type || '').toLowerCase();
  let tipo = tipoCat;
  if (/casa/.test(tipoTxt)) tipo = 'casa';
  else if (/apartamento/.test(tipoTxt)) tipo = 'apartamento';
  if (/kitnet|kitinete|studio/.test(tipoTxt) || /kitnet|studio/i.test(p.re_types || '')) tipo = 'kitnet';
  return {
    site: 'OLX',
    titulo: ad.subject || null,
    tipo,
    regiao: null,
    bairro,
    cidade,
    endereco: null,
    preco: num(ad.priceValue || ad.price),
    condominio: p.condominio != null ? num(p.condominio) : null,
    iptu: p.iptu != null ? num(p.iptu) : null,
    area_m2: p.size != null ? num(p.size) : null,
    quartos: p.rooms != null ? num(p.rooms) : null,
    banheiros: p.bathrooms != null ? num(p.bathrooms) : null,
    vagas: p.garage_spaces != null ? num(p.garage_spaces) : null,
    data_publicacao: ad.date ? isoDate(ad.date * 1000) : null,
    data_tipo: ad.date ? 'atualizado' : null, // "date" da listagem pode refletir bump; corrigido pela página do anúncio
    link: ad.url,
    coletado_em: new Date().toISOString(),
    _re_types: p.re_types || '',
    _categoria: ad.categoryName || ad.category || '',
  };
}

async function newContext(browser) {
  const ctx = await browser.newContext({
    userAgent: uaCoerente(browser),
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    window.chrome = window.chrome || { runtime: {} };
  });
  // economiza banda: bloqueia imagens/fontes/mídia
  await ctx.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'font' || t === 'media') return route.abort();
    return route.continue();
  });
  return ctx;
}

async function fetchHtml(page, url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const status = r ? r.status() : 0;
      const html = await page.content();
      if (status === 403 || /cf-challenge|Just a moment|captcha/i.test(await page.title())) {
        console.warn(`  bloqueio? status=${status} ${url}`);
        await jitter(4000, 8000);
        continue;
      }
      return html;
    } catch (e) {
      console.warn(`  erro ${e.message.split('\n')[0]} (${url})`);
      await jitter(2000, 4000);
    }
  }
  return null;
}

// Detalhes da página do anúncio: <script id="initial-data" data-json="...">
async function fetchDetail(browser, a) {
  let html = null;
  for (let t = 0; t < 3 && !html; t++) {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    html = await fetchHtml(page, a.link, 1);
    await ctx.close().catch(() => {});
    if (!html) { stats.detail403++; await jitter(5000, 10000); }
  }
  if (!html) return;
  stats.detailOk++;
  if (!html) return;
  const m = html.match(/<script id="initial-data"[^>]*data-json="([^"]*)"/);
  if (!m) return;
  const raw = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');
  let d;
  try { d = JSON.parse(raw); } catch (_) { return; }
  const ad = d.ad || d;
  const loc = ad.location || {};
  if (loc.address) a.endereco = [loc.address, loc.neighbourhood, loc.municipality, loc.uf].filter(Boolean).join(', ');
  else a.endereco = [loc.neighbourhood, loc.municipality, loc.uf].filter(Boolean).join(', ') || null;
  if (loc.neighbourhood) a.bairro = loc.neighbourhood;
  if (loc.zipcode) a.cep = loc.zipcode;
  if (ad.origListTime) { a.data_publicacao = isoDate(ad.origListTime * 1000); a.data_tipo = 'publicado'; }
  else if (ad.listTime) { a.data_publicacao = isoDate(ad.listTime); a.data_tipo = 'atualizado'; }
  const props = {};
  for (const p of ad.properties || []) props[p.name] = p.value;
  if (a.area_m2 == null && props.size) a.area_m2 = num(props.size);
  if (a.quartos == null && props.rooms) a.quartos = num(props.rooms);
  if (a.banheiros == null && props.bathrooms) a.banheiros = num(props.bathrooms);
  if (a.vagas == null && props.garage_spaces) a.vagas = num(props.garage_spaces);
  for (const pr of ad.realEstatePriceInfo || []) {
    const v = num(pr.value);
    if (pr.name === 'condominio' && a.condominio == null && v) a.condominio = v;
    if (pr.name === 'iptu' && a.iptu == null && v) a.iptu = v;
  }
  if (a.condominio == null && props.condominio) a.condominio = num(props.condominio);
  if (a.iptu == null && props.iptu) a.iptu = num(props.iptu);
}

const stats = { detailOk: 0, detail403: 0 };

// Descarta kitnet/studio/quarto, anúncios que não são aluguel residencial mensal e imóveis fora do DF permitido citados no título.
const RE_TIPO = /aluguel de quartos|quarto avulso|kit ?net|kinet|kitinete|quitinete|\bkit\b|studio|est[uú]dio|loft|compartilhad|\bdividir\b|(aluga|alugo|aluga-se)( um)? quarto\b(?! e)|quarto (imobili|mobiliad|para (homem|homens|mulher|rapaz|mo[cç]a|estudante))/i;
const RE_LIXO = /di[aá]ria|temporada|mudan[cç]a|sala comercial|loja|ponto comercial|galp[aã]o|\balugad[oa]\b|j[aá] foi alugad|\bvenda\b|caldas novas|thermas|papai noel/i;
const RE_FORA = /corumb[aá]|valpara[ií]so|[aá]guas lindas|samambaia|ceil[aâ]ndia|luzi[aâ]nia|novo gama|santo ant[oô]nio do descoberto|cidade ocidental|formosa|planaltina|recanto das emas|santa maria|gama\b|brazl[aâ]ndia|sol nascente/i;
function descartarTipo(a) {
  const txt = `${a.titulo} ${a._re_types} ${a._categoria}`;
  if (a.tipo === 'kitnet') return true;
  if (RE_TIPO.test(txt) || RE_LIXO.test(a.titulo || '')) return true;
  if (RE_FORA.test(a.titulo || '')) return true; // título cita cidade/RA fora da lista (ex.: "Cruzeiro do Sul Valparaíso de Goiás")
  if (a.bairro && !regiaoPermitida(a.bairro) && RE_FORA.test(a.bairro)) return true; // ex.: "Pôr do Sol (Ceilândia)"
  return false;
}

// Região: prioriza bairro, depois cidade, endereço e por último título.
function acharRegiao(a) {
  for (const t of [a.bairro, a.cidade, a.endereco, a.titulo]) { const r = regiaoPermitida(t || ''); if (r) return r; }
  return null;
}
function sanitiza(a) {
  if (a.area_m2 != null && (a.area_m2 > 1000 || a.area_m2 <= 0)) a.area_m2 = null; // erros de digitação (ex.: 41000)
  return a;
}

async function main() {
  // channel 'chromium' = Chromium completo em modo "new headless" (o headless-shell é mais fácil de identificar).
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  let brutos = 0;
  let bloqueado = false;
  const candidatos = new Map();

  for (const cat of CATEGORIAS) {
    for (let pg = 1; pg <= MAX_PAGES; pg++) {
      const url = `https://www.olx.com.br/imoveis/aluguel/${cat.path}/estado-df?pe=1200${pg > 1 ? `&o=${pg}` : ''}`;
      const html = await fetchHtml(page, url);
      if (!html) { bloqueado = true; break; }
      const { ads, total } = extractAds(html);
      const reais = ads.filter((x) => x && x.listId && x.url);
      console.log(`[${cat.tipo}] pág ${pg}: ${reais.length} anúncios (total site: ${total})`);
      if (!reais.length) break;
      brutos += reais.length;
      for (const ad of reais) {
        const a = fromListing(ad, cat.tipo);
        if (candidatos.has(a.link)) continue;
        sanitiza(a);
        a.regiao = acharRegiao(a);
        if (!a.regiao) continue;
        if (descartarTipo(a)) continue;
        if (!passaFiltro(a)) continue;
        candidatos.set(a.link, a);
      }
      if (total != null && pg * 50 >= total) break;
      await jitter(1200, 2500);
    }
  }
  console.log(`Brutos: ${brutos}; candidatos após filtro da listagem: ${candidatos.size}`);

  // Detalhes com concorrência limitada
  const lista = [...candidatos.values()];
  await ctx.close();
  // Anúncios já conhecidos (KNOWN_LINKS_FILE) com o mesmo preço: reaproveita os campos, sem abrir o detalhe.
  const paraDetalhe = lista.filter((a) => !reaproveitar(a));
  if (paraDetalhe.length < lista.length) console.log(`Conhecidos (sem detalhe): ${lista.length - paraDetalhe.length}; detalhes a abrir: ${paraDetalhe.length}`);
  let idx = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (idx < paraDetalhe.length) {
      const a = paraDetalhe[idx++];
      await fetchDetail(browser, a);
      if (idx % 20 === 0) console.log(`  detalhes: ${idx}/${paraDetalhe.length} (ok ${stats.detailOk}, 403 ${stats.detail403})`);
      await jitter(800, 2000);
    }
  }));
  await browser.close();

  const final = [];
  const seen = new Set();
  for (const a of lista) {
    sanitiza(a);
    a.regiao = acharRegiao(a);
    if (!a.regiao || !passaFiltro(a) || descartarTipo(a) || seen.has(a.link)) continue;
    seen.add(a.link);
    delete a._re_types; delete a._categoria;
    final.push(a);
  }
  final.sort((x, y) => x.preco - y.preco);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(final, null, 2));
  console.log(`Detalhes ok: ${stats.detailOk}, 403s: ${stats.detail403}`);
  console.log(`Brutos vistos: ${brutos} | passaram: ${final.length} | bloqueio: ${bloqueado} | salvo em ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
