// TEMPORÁRIO: testa abordagens para coletar OLX / ImovelWeb a partir do GitHub Actions.
// Uso: node scripts_teste/teste_bloqueio.js <variante...>   (variantes: fetch, headless, headed, chrome, chrome-headed, tor, warp, warp-chrome)
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const OLX_LIST = 'https://www.olx.com.br/imoveis/aluguel/apartamentos/estado-df/distrito-federal-e-regiao/brasilia/ra-xiv---sao-sebastiao?pe=1200';
const IW = 'https://www.imovelweb.com.br';
const WI = 'https://www.wimoveis.com.br';

function olxAds(html) {
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let full = '', m;
  while ((m = re.exec(html))) { try { full += JSON.parse(m[1]); } catch (_) {} }
  const urls = [...new Set((full.match(/"url":"https:\/\/[a-z]+\.olx\.com\.br\/[^"]+"/g) || []).map((x) => x.slice(7, -1)).filter((u) => /\d{8,}$/.test(u)))];
  const t = full.match(/"totalOfAds":(\d+)/);
  return { n: (full.match(/"listId":/g) || []).length, total: t ? +t[1] : null, urls };
}

async function esperarCF(page, ms = 12000) {
  const t0 = Date.now();
  let title = await page.title().catch(() => '');
  while (/just a moment|um momento|attention required/i.test(title) && Date.now() - t0 < ms) {
    await sleep(1500);
    title = await page.title().catch(() => '');
  }
  return title;
}

async function comTimeout(p, ms, label) {
  return Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout ${label}`); })]);
}

async function probeBrowser(label, launchOpts, ctxOpts = {}) {
  const res = { label };
  let browser;
  try {
    browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'], ...launchOpts });
    // UA coerente com o navegador real (sem "HeadlessChrome")
    const ver = browser.version();
    const plat = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
    const ua = `Mozilla/5.0 (${plat}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver.split('.')[0]}.0.0.0 Safari/537.36`;
    res.ver = ver;
    const ctx = await browser.newContext({ userAgent: ua, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }, ...ctxOpts });
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    const page = await ctx.newPage();
    // IP de saída
    try { await page.goto('https://www.cloudflare.com/cdn-cgi/trace', { timeout: 20000 }); const t = await page.innerText('body'); res.ip = (t.match(/ip=(.*)/) || [])[1] + ' ' + (t.match(/loc=(.*)/) || [])[1] + ' ' + (t.match(/warp=(.*)/) || [])[1]; } catch (e) { res.ip = 'erro ' + e.message.split('\n')[0]; }
    // OLX listagem
    try {
      const r = await page.goto(OLX_LIST, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const title = await esperarCF(page);
      const a = olxAds(await page.content());
      res.olx = `status=${r && r.status()} title="${title.slice(0, 50)}" ads=${a.n} total=${a.total}`;
      if (a.urls[0]) {
        const r2 = await page.goto(a.urls[0], { waitUntil: 'domcontentloaded', timeout: 45000 });
        const t2 = await esperarCF(page);
        const h = await page.content();
        res.olxDetalhe = `status=${r2 && r2.status()} title="${t2.slice(0, 40)}" initialData=${/id="initial-data"/.test(h)}`;
      }
    } catch (e) { res.olx = 'erro ' + e.message.split('\n')[0]; }
    // ImovelWeb
    for (const [nome, base, lst] of [['iw', IW, '/imoveis-aluguel-distrito-federal-menos-1200-reales.html'], ['wi', WI, '/aluguel/imoveis/df']]) {
      try {
        await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await esperarCF(page);
        await sleep(1200);
        const r = await page.goto(base + lst, { waitUntil: 'domcontentloaded', timeout: 45000 });
        const title = await esperarCF(page, 15000);
        const html = await page.content();
        const api = await page.evaluate(async () => {
          const r = await fetch('/rplis-api/postings', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
            body: JSON.stringify({ q: null, moneda: '3', preciomax: 1200, tipoDePropiedad: '2', tipoDeOperacion: '2', province: '247', pagina: 1, sort: 'relevance', tipoAnunciante: 'ALL' }) });
          const t = await r.text(); let n = null, tot = null; try { const j = JSON.parse(t); n = (j.listPostings || []).length; tot = j.paging && j.paging.total; } catch (_) {}
          return `api=${r.status} postings=${n} total=${tot}`;
        }).catch((e) => 'api erro ' + e.message.split('\n')[0]);
        res[nome] = `status=${r && r.status()} title="${title.slice(0, 50)}" cards=${(html.match(/data-id="\d+"/g) || []).length} ${api}`;
      } catch (e) { res[nome] = 'erro ' + e.message.split('\n')[0]; }
    }
  } catch (e) { res.erro = e.message.split('\n')[0]; }
  finally { if (browser) await browser.close().catch(() => {}); }
  console.log(JSON.stringify(res, null, 1));
}

async function probeFetch() {
  const H = { 'user-agent': MAC_UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'pt-BR,pt;q=0.9' };
  for (const u of [OLX_LIST, 'https://nga.olx.com.br/api/v1.2/public/ads?lim=5&region=7', 'https://apigw.olx.com.br/', 'https://m.olx.com.br/',
    'https://www.olx.com.br/sitemap.xml', IW + '/imoveis-aluguel-distrito-federal-menos-1200-reales.html', WI + '/aluguel/imoveis/df', 'https://www.dfimoveis.com.br/']) {
    try { const r = await fetch(u, { headers: H, redirect: 'manual', signal: AbortSignal.timeout(20000) }); const t = await r.text(); console.log(`fetch ${r.status} len=${t.length} ${(t.match(/<title>[^<]*/) || [''])[0].slice(7, 60)} ${u}`); }
    catch (e) { console.log(`fetch erro ${e.message} ${u}`); }
  }
}

(async () => {
  const vars = process.argv.slice(2);
  for (const v of vars) {
    console.log(`\n===== ${v} =====`);
    const t0 = Date.now();
    try {
      const run = {
        fetch: () => probeFetch(),
        headless: () => probeBrowser(v, { headless: true }, { userAgent: MAC_UA }),
        'headless-shell': () => probeBrowser(v, { headless: true }),
        'headless-new': () => probeBrowser(v, { headless: true, channel: 'chromium' }),
        headed: () => probeBrowser(v, { headless: false }),
        chrome: () => probeBrowser(v, { headless: true, channel: 'chrome' }),
        'chrome-headed': () => probeBrowser(v, { headless: false, channel: 'chrome' }),
        tor: () => probeBrowser(v, { headless: true, channel: 'chromium', proxy: { server: 'socks5://127.0.0.1:9050' } }),
        warp: () => probeBrowser(v, { headless: true, channel: 'chromium', proxy: { server: 'socks5://127.0.0.1:40000' } }),
        'warp-chrome-headed': () => probeBrowser(v, { headless: false, channel: 'chrome', proxy: { server: 'socks5://127.0.0.1:40000' } }),
      }[v];
      await comTimeout(run(), 110000, v);
    } catch (e) { console.log(`${v}: ${e.message}`); }
    console.log(`(${v} levou ${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  process.exit(0);
})();
