// Crawler de aluguel residencial no DF: Chaves na Mão + Mercado Livre Imóveis.
// Uso: node scrapers/chaves_mercadolivre.js  -> data/chaves_mercadolivre.json
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { regiaoPermitida, passaFiltro, FILTRO } = require('./common');
const { reaproveitar } = require('./known'); // KNOWN_LINKS_FILE: conhecido com o mesmo preço -> sem detalhe

const HOJE = new Date(); // datas relativas ('há 3 dias') contam a partir de agora
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MAX_PAGINAS = 20;
const CONCORRENCIA = 4;
const OUT = path.join(__dirname, '..', 'data', 'chaves_mercadolivre.json');

const stats = {};
const log = (...a) => console.log('[crawler]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const num = (s) => {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const m = String(s).replace(/\./g, '').replace(',', '.').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const isoDate = (s) => (s ? String(s).slice(0, 10) : null);

// 'há 3 dias', 'há 2 semanas', 'hoje', 'ontem', 'há 1 mês' -> ISO
function dataRelativa(txt) {
  if (!txt) return null;
  const t = txt.toLowerCase();
  const d = new Date(HOJE);
  if (/hoje/.test(t)) return d.toISOString().slice(0, 10);
  if (/ontem/.test(t)) { d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); }
  const m = t.match(/h[aá]\s+(\d+|um|uma)\s+(hora|dia|semana|m[eê]s|mes|ano)/);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  const u = m[2];
  if (u.startsWith('hora')) { /* mesmo dia */ }
  else if (u.startsWith('dia')) d.setDate(d.getDate() - n);
  else if (u.startsWith('semana')) d.setDate(d.getDate() - 7 * n);
  else if (u.startsWith('m')) d.setMonth(d.getMonth() - n);
  else if (u.startsWith('ano')) d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

const TIPOS_RESIDENCIAIS = /^(apartamento|casa|cobertura|sobrado|duplex|triplex|casa-em-condominio|casa-de-condominio|chacara|chácara)/i;
const TIPOS_EXCLUIDOS = /kitnet|kitinete|studio|est[uú]dio|flat|loft|quarto|vaga|comercial|sala|galp|terreno|ponto|pr[eé]dio|loja|barrac/i;

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function novoContexto(browser) {
  const ctx = await browser.newContext({ userAgent: UA, locale: 'pt-BR', viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9' } });
  await ctx.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  return ctx;
}

// ----------------------------------------------------------------- Chaves na Mão
async function chavesNaMao(browser) {
  const SITE = 'Chaves na Mão';
  const ctx = await novoContexto(browser);
  const page = await ctx.newPage();
  const vistos = new Map();
  for (let pg = 1; pg <= MAX_PAGINAS; pg++) {
    const url = `https://www.chavesnamao.com.br/imoveis-para-alugar/df/?filtro=pmax:${FILTRO.precoMax}${pg > 1 ? '&pg=' + pg : ''}`;
    let offers = [];
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const lds = await page.$$eval('script[type="application/ld+json"]', (s) => s.map((x) => x.textContent));
      for (const s of lds) {
        try { const j = JSON.parse(s); if (j['@type'] === 'RealEstateListing' && j.offers && j.offers.itemListElement) offers = j.offers.itemListElement; } catch {}
      }
    } catch (e) { log(SITE, 'erro página', pg, e.message); break; }
    let novos = 0;
    for (const o of offers) { if (o.url && !vistos.has(o.url)) { vistos.set(o.url, o); novos++; } }
    log(SITE, `página ${pg}: ${offers.length} anúncios, ${novos} novos`);
    if (!offers.length || !novos) break;
    await sleep(800);
  }
  stats[SITE] = { brutos: vistos.size };

  // Pré-filtro com os dados da listagem (evita visitar anúncios descartáveis)
  const candidatos = [];
  for (const [link, o] of vistos) {
    const it = o.itemOffered || {};
    const ad = it.address || {};
    const slugTipo = (link.match(/\/imovel\/([a-z-]+?)-para-alugar/) || [])[1] || '';
    const tipo = slugTipo.replace(/-/g, ' ');
    const titulo = o.name || '';
    if (!TIPOS_RESIDENCIAIS.test(slugTipo) || TIPOS_EXCLUIDOS.test(slugTipo)) continue;
    const bairro = ad.addressLocality || null;
    const cidade = ad.addressRegion || '';
    const endereco = [ad.streetAddress, bairro, cidade].filter(Boolean).join(', ');
    const regiao = regiaoPermitida([bairro, cidade, endereco, titulo].join(' '));
    const a = {
      site: SITE, titulo, tipo, regiao, bairro, endereco,
      preco: num(o.price), condominio: null, iptu: null,
      area_m2: num(it.floorSize && it.floorSize.unitText), quartos: it.numberOfBedrooms ?? null,
      banheiros: it.numberOfBathroomsTotal ?? null, vagas: null,
      data_publicacao: null, data_tipo: null, link, coletado_em: new Date().toISOString(),
    };
    if (!regiao || !passaFiltro(a)) continue;
    candidatos.push(a);
  }
  log(SITE, `${candidatos.length} candidatos após pré-filtro; visitando páginas dos anúncios`);

  await pool(candidatos, CONCORRENCIA, async (a) => {
    if (reaproveitar(a)) return;
    const p = await ctx.newPage();
    try {
      await p.goto(a.link, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const d = await p.evaluate(() => {
        const txt = document.body.innerText.replace(/\s+/g, ' ');
        let pub = null, mod = null, desc = null;
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const j = JSON.parse(s.textContent);
            for (const n of j['@graph'] || [j]) {
              pub = pub || n.datePosted || n.datePublished || null;
              mod = mod || n.dateModified || null;
              if (n['@type'] === 'RealEstateListing' && n.description) desc = n.description;
            }
          } catch {}
        }
        return { txt: txt.slice(0, 20000), pub, mod, desc };
      });
      const g = (re) => { const m = d.txt.match(re); return m ? m[1] : null; };
      const cond = g(/Condom[ií]nio\s*R\$\s*([\d.,]+)/i);
      const iptu = g(/IPTU\s*R\$\s*([\d.,]+)/i);
      a.condominio = cond ? num(cond) : null;
      a.iptu = iptu ? num(iptu) : null;
      const areaUtil = g(/[ÁA]rea [úu]til\s*([\d.,]+)\s*m/i) || g(/[ÁA]rea total\s*([\d.,]+)\s*m/i);
      if (areaUtil) a.area_m2 = num(areaUtil);
      const ban = g(/Banheiros?\s*(\d+)/i); if (ban) a.banheiros = Number(ban);
      const qua = g(/Quartos?\s*(\d+)/i); if (qua) a.quartos = Number(qua);
      const gar = g(/Garage(?:ns|m)\s*(\d+|--)/i); a.vagas = gar && gar !== '--' ? Number(gar) : (gar === '--' ? 0 : null);
      if (d.pub) { a.data_publicacao = isoDate(d.pub); a.data_tipo = 'publicado'; }
      else if (d.mod) { a.data_publicacao = isoDate(d.mod); a.data_tipo = 'atualizado'; }
      else {
        const at = g(/[ÚU]ltima atualiza[çc][ãa]o:\s*(\d{2}\/\d{2}\/\d{4})/i);
        if (at) { const [dd, mm, yy] = at.split('/'); a.data_publicacao = `${yy}-${mm}-${dd}`; a.data_tipo = 'atualizado'; }
      }
    } catch (e) { log(SITE, 'erro detalhe', a.link, e.message); }
    finally { await p.close(); }
  });
  await ctx.close();
  return candidatos;
}

// ----------------------------------------------------------------- Mercado Livre
async function mercadoLivre(browser) {
  const SITE = 'Mercado Livre';
  stats[SITE] = { brutos: 0, bloqueado: false };
  // 1) API pública (hoje exige token -> 403)
  try {
    const r = await fetch('https://api.mercadolibre.com/sites/MLB/search?category=MLB1459&state=TUxCUERJU0YxMjAxOQ&limit=50', { headers: { 'User-Agent': UA } });
    if (r.status !== 200) log(SITE, `API pública respondeu ${r.status} (requer autenticação)`);
  } catch (e) { log(SITE, 'API erro', e.message); }

  // 2) Listagem web
  const ctx = await novoContexto(browser);
  const page = await ctx.newPage();
  const vistos = new Map();
  const bases = ['apartamentos', 'casas'];
  for (const tipoBase of bases) {
    for (let pg = 0; pg < MAX_PAGINAS; pg++) {
      const desde = pg * 48 + 1;
      const url = `https://imoveis.mercadolivre.com.br/${tipoBase}/aluguel/distrito-federal/${pg ? `_Desde_${desde}_` : '_'}PriceRange_0BRL-${FILTRO.precoMax}BRL_NoIndex_True`;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (e) { log(SITE, 'erro', e.message); break; }
      if (/account-verification|\/login|\/jms\//.test(page.url())) {
        log(SITE, `BLOQUEADO: redirecionado para ${page.url().slice(0, 80)}... (exige login)`);
        stats[SITE].bloqueado = true;
        await ctx.close();
        return [];
      }
      const cards = await page.$$eval('li.ui-search-layout__item, .poly-card', (els) => els.map((el) => {
        const a = el.querySelector('a.poly-component__title, a.ui-search-link, a[href*="MLB"]');
        const t = (s) => (el.querySelector(s) || {}).textContent || '';
        return {
          link: a ? a.href.split('#')[0].split('?')[0] : null,
          titulo: (a && a.textContent.trim()) || t('.poly-component__title, h2, h3').trim(),
          preco: t('.andes-money-amount__fraction'),
          attrs: Array.from(el.querySelectorAll('.poly-attributes_list__item, .poly-attributes-list__item, .ui-search-card-attributes__attribute')).map((x) => x.textContent.trim()),
          local: t('.poly-component__location, .ui-search-item__location').trim(),
          headline: t('.poly-component__headline').trim(),
        };
      }));
      let novos = 0;
      for (const c of cards) if (c.link && !vistos.has(c.link)) { vistos.set(c.link, { ...c, tipoBase }); novos++; }
      log(SITE, `${tipoBase} pág ${pg + 1}: ${cards.length} cards, ${novos} novos`);
      if (!cards.length || !novos) break;
      await sleep(1200);
    }
  }
  stats[SITE].brutos = vistos.size;

  const cand = [];
  for (const [link, c] of vistos) {
    const attrs = c.attrs.join(' | ');
    const q = attrs.match(/(\d+)\s*quartos?/i), b = attrs.match(/(\d+)\s*banheiros?/i), ar = attrs.match(/([\d.,]+)\s*m²/i);
    const regiao = regiaoPermitida(`${c.local} ${c.titulo}`);
    const a = {
      site: SITE, titulo: c.titulo, tipo: c.tipoBase === 'casas' ? 'casa' : 'apartamento', regiao,
      bairro: (c.local.split(',').slice(-3, -2)[0] || c.local.split(',')[0] || '').trim() || null,
      endereco: c.local || null, preco: num(c.preco), condominio: null, iptu: null,
      area_m2: ar ? num(ar[1]) : null, quartos: q ? Number(q[1]) : null, banheiros: b ? Number(b[1]) : null,
      vagas: null, data_publicacao: null, data_tipo: null, link, coletado_em: new Date().toISOString(),
    };
    if (!regiao || !passaFiltro(a) || TIPOS_EXCLUIDOS.test(c.titulo)) continue;
    cand.push(a);
  }
  await pool(cand, CONCORRENCIA, async (a) => {
    if (reaproveitar(a)) return;
    const p = await ctx.newPage();
    try {
      await p.goto(a.link, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const txt = (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
      const g = (re) => { const m = txt.match(re); return m ? m[1] : null; };
      const cond = g(/Condom[ií]nio\s*R\$\s*([\d.,]+)/i); if (cond) a.condominio = num(cond);
      const iptu = g(/IPTU\s*R\$\s*([\d.,]+)/i); if (iptu) a.iptu = num(iptu);
      if (a.area_m2 == null) { const ar = g(/[ÁA]rea [úu]til\s*([\d.,]+)\s*m/i); if (ar) a.area_m2 = num(ar); }
      if (a.banheiros == null) { const b = g(/Banheiros\s*(\d+)/i); if (b) a.banheiros = Number(b); }
      const v = g(/Vagas(?: de garagem)?\s*(\d+)/i); if (v) a.vagas = Number(v);
      const pub = g(/(Publicado h[aá] [^|.]{1,20})/i) || g(/(h[aá] \d+ (?:dias?|semanas?|m[eê]s(?:es)?|anos?))/i);
      if (pub) { a.data_publicacao = dataRelativa(pub); a.data_tipo = 'publicado'; }
    } catch (e) { log(SITE, 'erro detalhe', e.message); }
    finally { await p.close(); }
  });
  await ctx.close();
  return cand;
}

// ----------------------------------------------------------------- main
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  let todos = [];
  for (const [nome, fn] of [['Chaves na Mão', chavesNaMao], ['Mercado Livre', mercadoLivre]]) {
    try { todos = todos.concat(await fn(browser)); }
    catch (e) { log(nome, 'falhou:', e.message); stats[nome] = { ...(stats[nome] || {}), erro: e.message }; }
  }
  await browser.close();

  const porLink = new Map();
  for (const a of todos) {
    if (!passaFiltro(a) || !a.regiao) { log('descartado após detalhe:', a.site, a.preco, a.area_m2 + 'm2', a.quartos + 'q', a.banheiros + 'b', a.link); continue; }
    if (!porLink.has(a.link)) porLink.set(a.link, a);
  }
  const final = [...porLink.values()].sort((x, y) => x.preco - y.preco);
  for (const s of Object.keys(stats)) stats[s].aprovados = final.filter((a) => a.site === s).length;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(final, null, 2));
  if (reaproveitar.total) log(`conhecidos (sem detalhe): ${reaproveitar.total}`);
  log('resumo', JSON.stringify(stats));
  log(`salvo ${final.length} anúncios em ${OUT}`);
})();
