'use strict';
// Instrumentação de rede para os crawlers (Playwright + fetch do Node).
//
//   const { instrument, getStats, resetStats } = require('./monitor/instrument');
//   instrument({ block: true });          // ANTES de require('./scrapers/...')
//   ... roda o crawler ...
//   console.log(getStats());
//
// - Faz monkeypatch em require('playwright').chromium.launch / launchPersistentContext:
//   todo Browser -> BrowserContext -> Page criado passa a ser contabilizado e (se block)
//   tem recursos desnecessários bloqueados via context.route('**/*').
// - Contabiliza bytes de saída (headers + corpo da requisição) e de entrada (headers +
//   corpo da resposta, tamanho CODIFICADO, i.e. como trafegou) por hostname, usando
//   request.sizes() do Playwright e diagnostics_channel do undici para o fetch do Node.
// - Os números são de camada HTTP. O tráfego real no fio (TLS handshake, cabeçalhos
//   TCP/IP, ACKs, QUIC) é maior; ver monitor/medir_trafego.js (medição via nettop).

const dc = require('diagnostics_channel');

// ------------------------------------------------------------------ regras de bloqueio
const TIPOS_BLOQUEADOS = new Set(['image', 'media', 'font', 'stylesheet', 'manifest', 'texttrack', 'ping', 'beacon', 'cspviolationreport']);

// sufixos de hostname de ads/analytics/tracking/widgets (bloqueados qualquer que seja o tipo)
const HOSTS_BLOQUEADOS = [
  // Google ads/analytics
  'googletagmanager.com', 'google-analytics.com', 'analytics.google.com', 'googleadservices.com', 'googlesyndication.com',
  'googletagservices.com', 'doubleclick.net', 'adservice.google.com', 'adservice.google.com.br', 'pagead2.googlesyndication.com',
  'imasdk.googleapis.com', 'fundingchoicesmessages.google.com', 'googleoptimize.com',
  // redes sociais / pixels
  'facebook.net', 'facebook.com', 'fbcdn.net', 'instagram.com', 'tiktok.com', 'tiktokw.us', 'ttwstatic.com', 'byteoversea.com',
  'ads-twitter.com', 'twitter.com', 'x.com', 'linkedin.com', 'licdn.com', 'pinterest.com', 'pinimg.com', 'sc-static.net', 'snapchat.com',
  'bat.bing.com', 'clarity.ms', 'reddit.com', 'redditstatic.com', 'kwai.com', 'kwaicdn.com',
  // analytics / RUM / APM / session replay
  'hotjar.com', 'hotjar.io', 'newrelic.com', 'nr-data.net', 'datadoghq.com', 'datadoghq-browser-agent.com', 'datadoghq.eu',
  'sentry.io', 'sentry-cdn.com', 'ingest.sentry.io', 'segment.com', 'segment.io', 'mixpanel.com', 'amplitude.com', 'heap.io', 'heapanalytics.com',
  'fullstory.com', 'mouseflow.com', 'smartlook.com', 'smartlook.cloud', 'logrocket.com', 'lr-ingest.io', 'lr-ingest.com', 'logr-ingest.com',
  'dynatrace.com', 'go-mpulse.net', 'akstat.io', 'speedcurve.com', 'bugsnag.com', 'rollbar.com', 'trackjs.com', 'cloudflareinsights.com',
  'chartbeat.com', 'chartbeat.net', 'scorecardresearch.com', 'quantserve.com', 'quantcount.com', 'crazyegg.com', 'luckyorange.com',
  'luckyorange.net', 'mc.yandex.ru', 'yandex.ru', 'contentsquare.net', 'contentsquare.com', 'quantummetric.com', 'kameleoon.com', 'kameleoon.eu',
  'visualwebsiteoptimizer.com', 'optimizely.com', 'abtasty.com', 'appsflyer.com', 'onelink.me', 'branch.io', 'app.link', 'braze.com',
  'clevertap.com', 'clevertap-prod.com', 'onesignal.com', 'pushnews.com.br', 'insider.com', 'useinsider.com', 'rdstation.com.br',
  'rdstation.com', 'd335luupugsy2.cloudfront.net', 'navegg.com', 'dmp.navdmp.com', 'navdmp.com', 'tiqcdn.com', 'tealiumiq.com',
  'adobedtm.com', 'omtrdc.net', 'demdex.net', 'everesttech.net', 'mathtag.com', 'bluekai.com', 'krxd.net', 'exelator.com',
  'cdn.cookielaw.org', 'cookielaw.org', 'onetrust.com', 'cookiebot.com', 'consensu.org', 'privacy-center.org', 'didomi.io', 'usercentrics.eu',
  'userway.org', 'acsbapp.com', 'accessibe.com', 'handtalk.me', 'vlibras.gov.br',
  // mídia programática
  'criteo.com', 'criteo.net', 'taboola.com', 'taboolasyndication.com', 'outbrain.com', 'outbrainimg.com', 'adnxs.com', 'rubiconproject.com',
  'pubmatic.com', 'openx.net', 'amazon-adsystem.com', 'casalemedia.com', 'teads.tv', 'smartadserver.com', 'adsrvr.org', 'rtbhouse.com',
  'creativecdn.com', 'doubleverify.com', 'adsafeprotected.com', 'moatads.com', 'yieldmo.com', 'sharethrough.com', '3lift.com', 'bidswitch.net',
  'media.net', 'lijit.com', 'sovrn.com', 'indexww.com', 'contextweb.com', 'adform.net', 'serving-sys.com', 'flashtalking.com', 'zemanta.com',
  'mgid.com', 'spotxchange.com', 'springserve.com', 'tapad.com', 'id5-sync.com', 'liadm.com', 'crwdcntrl.net', 'eyeota.net', 'agkn.com',
  'adsplay.com.br', 'bidr.io', 'hubspot.com', 'hs-scripts.com', 'hs-analytics.net', 'hsforms.net', 'hscollectedforms.net', 'hs-banner.com',
  'hsadspixel.net', 'usemessages.com',
  // chats / widgets
  'zdassets.com', 'zendesk.com', 'intercom.io', 'intercomcdn.com', 'tawk.to', 'jivosite.com', 'zopim.com', 'blip.ai', 'take.net',
  'octadesk.com', 'crisp.chat', 'livechatinc.com', 'drift.com', 'smartsupp.com', 'leadster.com.br', 'huggy.io', 'callbell.eu',
  'youtube.com', 'ytimg.com', 'vimeo.com', 'vimeocdn.com', 'maps.googleapis.com', 'maps.gstatic.com',
  'accounts.google.com', 'goadopt.io', 'hypr.mobi', 'onetag-sys.com', 'seedtag.com', 'richaudience.com', 'e-planning.net',
  // tracking/observabilidade próprios dos portais (vistos na medição)
  'lurker.olx.com.br', 'observability.chavesnamao.com.br', 'cdn.track.vivareal.com.br', 'cdn.track.zapimoveis.com.br',
];

// NUNCA bloquear (anti-bot / captcha / desafios): se forem bloqueados, o site devolve challenge.
const HOSTS_PERMITIDOS = [
  'challenges.cloudflare.com', 'hcaptcha.com', 'recaptcha.net', 'captcha-delivery.com', 'datadome.co', 'perimeterx.net', 'px-cdn.net',
  'px-cloud.net', 'pxchk.net', 'arkoselabs.com', 'funcaptcha.com', 'geetest.com',
];
const PATHS_PERMITIDOS = [/\/cdn-cgi\//, /\/recaptcha\//, /\/turnstile\//, /\/akam\//, /\/_Incapsula_Resource/, /\/__imp_apg__\//];

// Portais cujo HTML já vem renderizado no servidor (SSR) e cujos crawlers leem o HTML/DOM ou chamam a
// API interna via page.evaluate(fetch) — o JS próprio do site é dispensável. Bloqueia os scripts
// servidos por estes domínios (os desafios Cloudflare /cdn-cgi/ continuam liberados). Testado por
// contagem de anúncios iguais com/sem bloqueio (monitor/medir_trafego.js).
const SEM_JS = [
  'olx.com.br', 'chavesnamao.com.br', 'casamineira.com.br', 'naventcdn.com', 'imovelweb.com.br', 'wimoveis.com.br',
  'dfimoveis.com.br', 'netimoveis.com', 'zapimoveis.com.br', 'vivareal.com.br', 'vivareal.com', 'grupozap.com',
  'lugarcerto.com.br', 'mercadolivre.com.br', 'mlstatic.com', 'privacymanager.io', 'insurads.com',
];

// sites (sufixo de hostname) em que o CSS NÃO pode ser bloqueado (preenchido após testes; ver medicao)
const CSS_PERMITIDO = [];

const sufixo = (host, lista) => lista.some((d) => host === d || host.endsWith('.' + d));
function hostDe(url) { try { return new URL(url).hostname; } catch { return '?'; } }

function motivoBloqueio(url, tipo, cfg) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return null;
  const host = u.hostname;
  if (sufixo(host, HOSTS_PERMITIDOS) || PATHS_PERMITIDOS.some((re) => re.test(u.pathname))) return null;
  if (sufixo(host, cfg.hosts)) return 'host';
  if (tipo === 'script' && sufixo(host, cfg.semJs)) return 'script-ssr';
  if (cfg.tipos.has(tipo)) {
    if (tipo === 'stylesheet' && sufixo(host, cfg.cssPermitido)) return null;
    return 'tipo';
  }
  return null;
}

// ------------------------------------------------------------------ cache persistente de scripts/CSS
// Com page.route() ativo o Chromium desliga o cache HTTP, e cada página baixa de novo todos os
// bundles JS do site (OLX, Chaves, Navent...). Aqui guardamos em disco os estáticos (GET script/CSS,
// status 200, cacheáveis pelo Cache-Control ou com hash no nome) e os servimos via route.fulfill()
// nas próximas páginas E nas próximas execuções. Desafios anti-bot nunca são cacheados.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TIPOS_CACHE = new Set(['script', 'stylesheet']);
const HEADERS_FORA = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie', 'date', 'age', 'connection',
  'keep-alive', 'alt-svc', 'report-to', 'nel', 'server-timing', 'cf-ray', 'x-cache', 'via', 'expires', 'last-modified', 'etag']);
const cacheMem = new Map(); // url -> {meta, body} (LRU simples, ~40 MB)
let cacheMemBytes = 0;
const RE_HASH = /[._\-/~][0-9a-z]*\d[0-9a-z]*[a-z][0-9a-z]{6,}\.(m?js|css)(\?|$)|[._\-/][0-9a-f]{8,}[._\-/]|[?&](v|ver|version|hash|h|build|t)=[\w.-]{4,}/i;

function cacheKey(url) { return crypto.createHash('sha1').update(url).digest('hex'); }
function podeCachear(url, tipo, method) {
  if (!cfg || !cfg.cacheDir || method !== 'GET' || !TIPOS_CACHE.has(tipo)) return false;
  let u; try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  // JS versionado do reCAPTCHA (www.gstatic.com/recaptcha/releases/<hash>/...): estático e imutável, pode
  // ser servido do cache sem afetar o desafio. O DFimóveis o carrega em cada página de detalhe (~350 KB cada).
  if (/(^|\.)gstatic\.com$/.test(u.hostname) && /^\/recaptcha\/releases\//.test(u.pathname)) return true;
  if (sufixo(u.hostname, HOSTS_PERMITIDOS) || PATHS_PERMITIDOS.some((re) => re.test(u.pathname))) return false;
  return true;
}
function cacheGet(url) {
  const m = cacheMem.get(url);
  if (m) { if (m.meta.exp > Date.now()) { cacheMem.delete(url); cacheMem.set(url, m); return m; } cacheMem.delete(url); }
  const k = cacheKey(url);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(cfg.cacheDir, k + '.json'), 'utf8'));
    if (meta.url !== url || meta.exp <= Date.now()) return null;
    const body = fs.readFileSync(path.join(cfg.cacheDir, k + '.bin'));
    cachePutMem(url, { meta, body });
    return { meta, body };
  } catch { return null; }
}
function cachePutMem(url, e) {
  cacheMem.set(url, e); cacheMemBytes += e.body.length;
  while (cacheMemBytes > 40e6 && cacheMem.size) { const [k, v] = cacheMem.entries().next().value; cacheMem.delete(k); cacheMemBytes -= v.body.length; }
}
function ttlDe(url, headers) {
  const cc = String(headers['cache-control'] || '').toLowerCase();
  if (/no-store|private/.test(cc)) return 0;
  const ma = Number((cc.match(/(?:s-)?max-age=(\d+)/) || [])[1] || 0);
  if (/immutable/.test(cc) || RE_HASH.test(url)) return 30 * 86400e3;
  if (ma >= 600) return Math.min(ma * 1000, 7 * 86400e3);
  return 0;
}
async function cacheStore(response) {
  const req = response.request();
  const url = req.url();
  if (response.status() !== 200 || cacheGet(url)) return;
  const headers = await response.allHeaders().catch(() => response.headers());
  const ttl = ttlDe(url, headers);
  if (!ttl) return;
  const body = await response.body().catch(() => null);
  if (!body || body.length > 15e6) return;
  const h = {};
  for (const [k, v] of Object.entries(headers)) if (!HEADERS_FORA.has(k) && !k.startsWith(':')) h[k] = v;
  const meta = { url, status: 200, headers: h, exp: Date.now() + ttl, salvoEm: Date.now(), bytes: body.length };
  const k = cacheKey(url);
  try {
    fs.mkdirSync(cfg.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cfg.cacheDir, k + '.bin'), body);
    fs.writeFileSync(path.join(cfg.cacheDir, k + '.json'), JSON.stringify(meta));
  } catch {}
  cachePutMem(url, { meta, body });
}
function podaCache(dir, maxBytes = 300e6) {
  try {
    const arqs = fs.readdirSync(dir).filter((f) => f.endsWith('.bin')).map((f) => { const st = fs.statSync(path.join(dir, f)); return { f, t: st.mtimeMs, n: st.size }; });
    let tot = arqs.reduce((s, a) => s + a.n, 0);
    const agora = Date.now();
    for (const a of arqs.sort((x, y) => x.t - y.t)) {
      let expirado = false;
      try { expirado = JSON.parse(fs.readFileSync(path.join(dir, a.f.replace(/\.bin$/, '.json')), 'utf8')).exp < agora; } catch { expirado = true; }
      if (!expirado && tot <= maxBytes) continue;
      try { fs.rmSync(path.join(dir, a.f)); fs.rmSync(path.join(dir, a.f.replace(/\.bin$/, '.json')), { force: true }); tot -= a.n; } catch {}
    }
  } catch {}
}
const servidosDoCache = new WeakSet();
async function tentaCache(route, req) {
  if (!podeCachear(req.url(), req.resourceType(), req.method())) return false;
  const e = cacheGet(req.url());
  if (!e) return false;
  servidosDoCache.add(req);
  stats.cacheHits++; stats.cacheBytes += e.body.length;
  await route.fulfill({ status: e.meta.status, headers: e.meta.headers, body: e.body }).catch(() => {});
  return true;
}

// ------------------------------------------------------------------ estatísticas
let stats;
function novoStats() {
  return { requests: 0, blocked: 0, cacheHits: 0, cacheBytes: 0, abortedByCrawler: 0, failed: 0, bytesOut: 0, bytesIn: 0, nodeConnections: 0, porHost: {}, porTipo: {} };
}
stats = novoStats();
const pendentes = new Set();

function bucket(obj, k) {
  return obj[k] || (obj[k] = { requests: 0, blocked: 0, bytesOut: 0, bytesIn: 0 });
}
function conta({ host, tipo, out = 0, inn = 0, req = 0, blk = 0 }) {
  const h = bucket(stats.porHost, host || '?');
  const t = bucket(stats.porTipo, tipo || '?');
  for (const b of [stats, h, t]) { b.requests += req; b.blocked += blk; b.bytesOut += out; b.bytesIn += inn; }
}

function getStats() {
  const s = JSON.parse(JSON.stringify(stats));
  const ord = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => (b[1].bytesIn + b[1].bytesOut) - (a[1].bytesIn + a[1].bytesOut)));
  s.porHost = ord(s.porHost);
  s.porTipo = ord(s.porTipo);
  s.pendentes = pendentes.size;
  return s;
}
function resetStats() { stats = novoStats(); }
async function flush() { while (pendentes.size) await Promise.allSettled([...pendentes]); }

// ------------------------------------------------------------------ Playwright
let cfg = null;
const PATCHED = Symbol('instrumented');

function track(p) { pendentes.add(p); p.finally(() => pendentes.delete(p)); return p; }

function estimaSaida(request) {
  // requisição que não chegou a ter resposta (falha de rede): estima o que foi enviado
  let n = request.method().length + request.url().length + 12;
  try { for (const [k, v] of Object.entries(request.headers())) n += k.length + v.length + 4; } catch {}
  try { const b = request.postDataBuffer(); if (b) n += b.length; } catch {}
  return n;
}

function wrapHandler(handler) {
  // envolve handlers de route dos crawlers: nossas regras de bloqueio rodam primeiro
  if (typeof handler !== 'function' || !cfg.block) return handler;
  if (handler.__instrWrapped) return handler.__instrWrapped;
  const w = async (route, request) => {
    const req = request || route.request();
    if (motivoBloqueio(req.url(), req.resourceType(), cfg)) return route.abort('blockedbyclient').catch(() => {});
    if (await tentaCache(route, req)) return;
    return handler(route, req);
  };
  handler.__instrWrapped = w;
  return w;
}

function patchRoutable(obj) {
  const origRoute = obj.route.bind(obj);
  obj.route = (url, handler, opts) => origRoute(url, wrapHandler(handler), opts);
  if (obj.unroute) {
    const origUnroute = obj.unroute.bind(obj);
    obj.unroute = (url, handler) => origUnroute(url, handler && handler.__instrWrapped ? handler.__instrWrapped : handler);
  }
  return origRoute;
}

async function instrumentContext(ctx) {
  if (!ctx || ctx[PATCHED]) return ctx;
  ctx[PATCHED] = true;
  ctx.on('requestfinished', (request) => {
    if (servidosDoCache.has(request)) return; // veio do cache local, não da rede
    const host = hostDe(request.url());
    const tipo = request.resourceType();
    track(request.sizes().then(
      (s) => conta({ host, tipo, req: 1, out: s.requestHeadersSize + s.requestBodySize, inn: s.responseHeadersSize + s.responseBodySize }),
      () => conta({ host, tipo, req: 1, out: estimaSaida(request) }),
    ));
  });
  ctx.on('requestfailed', (request) => {
    const host = hostDe(request.url());
    const tipo = request.resourceType();
    const err = (request.failure() || {}).errorText || '';
    if (/BLOCKED_BY_CLIENT/.test(err)) return conta({ host, tipo, blk: 1 }); // nosso bloqueio (não foi para a rede)
    if (err === 'net::ERR_FAILED' && ['image', 'media', 'font'].includes(tipo)) { stats.abortedByCrawler++; return conta({ host, tipo, blk: 1 }); }
    stats.failed++;
    conta({ host, tipo, req: 1, out: estimaSaida(request) });
  });
  const origRoute = patchRoutable(ctx);
  if (cfg.block) {
    // rota "de base" do contexto: bloqueia o que deve; o resto segue para as rotas do crawler/rede
    await origRoute('**/*', async (route) => {
      const req = route.request();
      if (motivoBloqueio(req.url(), req.resourceType(), cfg)) return route.abort('blockedbyclient').catch(() => {});
      if (await tentaCache(route, req)) return;
      return route.fallback();
    });
    if (cfg.cacheDir) {
      ctx.on('response', (response) => {
        const req = response.request();
        if (servidosDoCache.has(req) || !podeCachear(req.url(), req.resourceType(), req.method())) return;
        track(cacheStore(response).catch(() => {}));
      });
    }
  }
  const origNewPage = ctx.newPage.bind(ctx);
  ctx.newPage = async (...a) => { const p = await origNewPage(...a); if (p && !p[PATCHED]) { p[PATCHED] = true; patchRoutable(p); } return p; };
  const origClose = ctx.close.bind(ctx);
  ctx.close = async (...a) => { await flush().catch(() => {}); return origClose(...a); };
  return ctx;
}

function instrumentBrowser(browser) {
  if (!browser || browser[PATCHED]) return browser;
  browser[PATCHED] = true;
  const origNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...a) => instrumentContext(await origNewContext(...a)); // browser.newPage usa this.newContext
  const origClose = browser.close.bind(browser);
  browser.close = async (...a) => { await flush().catch(() => {}); return origClose(...a); };
  return browser;
}

function patchBrowserType(bt) {
  if (!bt || bt[PATCHED]) return;
  bt[PATCHED] = true;
  const origLaunch = bt.launch.bind(bt);
  bt.launch = async (...a) => instrumentBrowser(await origLaunch(...a));
  if (bt.launchPersistentContext) {
    const origLPC = bt.launchPersistentContext.bind(bt);
    bt.launchPersistentContext = async (...a) => instrumentContext(await origLPC(...a));
  }
  if (bt.connectOverCDP) {
    const origCDP = bt.connectOverCDP.bind(bt);
    bt.connectOverCDP = async (...a) => instrumentBrowser(await origCDP(...a));
  }
}

// ------------------------------------------------------------------ fetch do Node (undici)
// Contagem de requisições no wrapper de globalThis.fetch; bytes via diagnostics_channel do undici
// (headers enviados, corpo enviado, headers recebidos e corpo recebido ainda COMPRIMIDO).
let fetchPatched = false;
function patchNodeFetch() {
  if (fetchPatched) return;
  fetchPatched = true;
  const reqHost = (r) => { try { return new URL(r.path, r.origin).hostname; } catch { return String(r.origin || '?').replace(/^https?:\/\//, ''); } };
  dc.subscribe('undici:client:sendHeaders', ({ request, headers }) => conta({ host: reqHost(request), tipo: 'node-fetch', out: Buffer.byteLength(String(headers || '')) }));
  dc.subscribe('undici:request:bodyChunkSent', ({ request, chunk }) => conta({ host: reqHost(request), tipo: 'node-fetch', out: chunk ? chunk.length : 0 }));
  dc.subscribe('undici:request:headers', ({ request, response }) => {
    let n = 17 + String(response.statusText || '').length;
    for (const h of response.headers || []) n += (h ? h.length : 0) + 2;
    conta({ host: reqHost(request), tipo: 'node-fetch', inn: n });
  });
  dc.subscribe('undici:request:bodyChunkReceived', ({ request, chunk }) => conta({ host: reqHost(request), tipo: 'node-fetch', inn: chunk ? chunk.length : 0 }));
  dc.subscribe('undici:client:connected', () => { stats.nodeConnections++; });
  if (typeof globalThis.fetch === 'function' && !globalThis.fetch[PATCHED]) {
    const origFetch = globalThis.fetch;
    const f = function fetch(input, init) {
      let url = typeof input === 'string' ? input : input && (input.url || input.href) || String(input);
      const host = hostDe(url);
      if (cfg && cfg.block && sufixo(host, cfg.hosts)) { conta({ host, tipo: 'node-fetch', blk: 1 }); return Promise.reject(new TypeError('blocked by instrument')); }
      conta({ host, tipo: 'node-fetch', req: 1 });
      return origFetch.call(this, input, init).catch((e) => { stats.failed++; throw e; });
    };
    f[PATCHED] = true;
    globalThis.fetch = f;
  }
}

// ------------------------------------------------------------------ API
function instrument({ block = true, cache = block, cacheDir = path.join(__dirname, '.cache_http'), cssPermitido = [], hostsExtras = [], tiposBloqueados, semJs = SEM_JS } = {}) {
  cfg = {
    semJs,
    block,
    cacheDir: block && cache ? cacheDir : null,
    tipos: tiposBloqueados ? new Set(tiposBloqueados) : TIPOS_BLOQUEADOS,
    hosts: [...HOSTS_BLOQUEADOS, ...hostsExtras],
    cssPermitido: [...CSS_PERMITIDO, ...cssPermitido],
  };
  const pw = require('playwright');
  for (const k of ['chromium', 'firefox', 'webkit']) patchBrowserType(pw[k]);
  try { const core = require('playwright-core'); for (const k of ['chromium', 'firefox', 'webkit']) patchBrowserType(core[k]); } catch {}
  patchNodeFetch();
  if (cfg.cacheDir) podaCache(cfg.cacheDir);
  return { getStats, resetStats };
}

module.exports = { instrument, getStats, resetStats, flush, motivoBloqueio: (u, t) => motivoBloqueio(u, t, cfg), HOSTS_BLOQUEADOS, TIPOS_BLOQUEADOS, SEM_JS };
