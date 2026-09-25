// Crawler de aluguel residencial do DFimóveis (dfimoveis.com.br).
//
// O site fica atrás do Cloudflare: fetch/curl recebe 403 ("Just a moment..."), e o Chromium
// no headless antigo passa na primeira página mas é desafiado nas seguintes. O modo headless
// novo (channel: 'chromium') + UA coerente com a versão real passa sem desafio.
//
// Estratégia: a busca /aluguel/df/todos/<tipo>?valorfinal=1200 já traz TODOS os anúncios do DF
// até R$ 1.200 (poucas centenas), então varremos o DF inteiro por tipo, paginando até acabar,
// e filtramos a região localmente com regiaoPermitida(). Isso cobre todas as cidades/bairros
// permitidos com bem menos requisições do que varrer cidade a cidade.
// A listagem não traz banheiros/IPTU/condomínio, então visitamos a página de cada candidato.
//
// Uso: node scrapers/dfimoveis.js

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { regiaoPermitida, passaFiltro, FILTRO } = require('./common');
const { reaproveitar } = require('./known');

const BASE = 'https://www.dfimoveis.com.br';
const TIPOS = ['apartamento', 'casa', 'casa-condominio'];
const CONCORRENCIA = 3; // mais que isso dispara HTTP 429 do Cloudflare
const MAX_PAGINAS = 60;
const OUT = path.join(__dirname, '..', 'data', 'dfimoveis.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a));

// "1.140" / "54,00" -> número
function num(s) {
  if (s == null) return null;
  const m = String(s).replace(/\s/g, '').match(/\d[\d.]*(,\d+)?/);
  if (!m) return null;
  const v = parseFloat(m[0].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

function isoHoje(offsetDias = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDias);
  return d.toISOString().slice(0, 10);
}

// "dd/mm/aa" ou "dd/mm/aaaa" -> "aaaa-mm-dd"
function dataBr(s) {
  const m = (s || '').match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
  if (!m) return null;
  const ano = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${ano}-${m[2]}-${m[1]}`;
}

// "1 dia", "3 horas", "2 semanas", "5 meses" -> ISO
function dataRelativa(s) {
  const m = (s || '').toLowerCase().match(/(\d+)\s*(minuto|hora|dia|semana|m[eê]s|mes|ano)/);
  if (!m) return null;
  const n = +m[1];
  const u = m[2];
  const dias = /minuto|hora/.test(u) ? 0 : u === 'dia' ? n : u === 'semana' ? n * 7 : /m[eê]s|mes/.test(u) ? n * 30 : n * 365;
  return isoHoje(dias);
}

async function esperarCloudflare(page) {
  for (let i = 0; i < 20; i++) {
    const t = await page.title().catch(() => '');
    if (!/just a moment|um momento|attention required/i.test(t)) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

async function abrir(page, url, tentativas = 3) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const ok = await esperarCloudflare(page);
      if (ok && r && r.status() < 400) return true;
      if (ok && r && r.status() === 404) return false;
      console.warn(`  [${r && r.status()}] bloqueio/erro em ${url} (tentativa ${i})`);
    } catch (e) {
      console.warn(`  erro ao abrir ${url}: ${e.message} (tentativa ${i})`);
    }
    await sleep(12000 * i + jitter(0, 4000)); // 429: recua
  }
  return false;
}

// Extrai os cards de uma página de resultados.
function extrairCards() {
  return [...document.querySelectorAll('article a.imovel-card[href^="/imovel/"]')].map((a) => {
    const txt = (sel) => (a.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
    const pills = [...a.querySelectorAll('.imovel-feature > div')].map((d) => d.textContent.replace(/\s+/g, ' ').trim());
    const desc = txt('p[itemprop=description]');
    return {
      href: a.getAttribute('href'),
      local: txt('h2[itemprop=name]'),
      h3: txt('h3'),
      subtitulo: txt('p.web-ellipse-view'),
      preco: a.querySelector('[itemprop=price]')?.getAttribute('content') || txt('.imovel-price strong'),
      pills,
      dataCard: (desc.match(/(\d{2}\/\d{2}\/\d{2,4})\s*$/) || [])[1] || null,
    };
  });
}

function parseCard(c, tipoBusca) {
  const link = BASE + c.href;
  const slug = c.href.split('/').pop();
  const pill = (re) => {
    const p = c.pills.find((x) => re.test(x));
    return p ? num(p) : null;
  };
  // local = "ENDEREÇO, BAIRRO, CIDADE"
  const partes = c.local.split(',').map((s) => s.trim()).filter(Boolean);
  const cidade = partes.length >= 2 ? partes[partes.length - 1] : null;
  const bairro = partes.length >= 2 ? partes[partes.length - 2] : partes[0] || null;
  const endereco = partes.length >= 3 ? partes.slice(0, -2).join(', ') : null;
  const tipoSlug = slug.split('-')[0];
  return {
    site: 'DFimóveis',
    titulo: (c.subtitulo || '').replace(/^[,\s-]+/, '') || c.h3 || slug,
    tipo: tipoSlug === 'casa' && tipoBusca === 'casa-condominio' ? 'casa em condomínio' : tipoSlug,
    // bairro primeiro: "ITAPOA PARQUE, PARANOA" deve dar Itapoã, não Paranoá.
    regiao: regiaoPermitida(bairro) || regiaoPermitida(cidade) || regiaoPermitida(c.local),
    bairro,
    cidade,
    endereco,
    preco: num(c.preco),
    condominio: null,
    iptu: null,
    area_m2: pill(/m²/),
    quartos: pill(/quarto/i),
    banheiros: null,
    vagas: pill(/vaga/i),
    data_publicacao: dataBr(c.dataCard),
    data_tipo: c.dataCard ? 'publicado' : null,
    link,
    _slug: slug,
  };
}

// Completa com dados da página do anúncio.
async function detalhar(page, a) {
  if (!(await abrir(page, a.link))) return a;
  const d = await page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    let t = main.innerText;
    const corte = t.search(/Buscar em outras cidades|DFIMOVEIS\.COM\n/);
    if (corte > 0) t = t.slice(0, corte);
    const campo = (re) => (t.match(re) || [])[1] || null;
    const det = [...document.querySelectorAll('ul.details-text li')].map((li) => li.innerText.replace(/\s+/g, ' ').trim());
    return {
      h1: document.querySelector('h1')?.innerText?.trim() || null,
      area: campo(/[ÁA]rea\s*[ÚU]til:?\s*([\d.,]+)\s*m²/i) || campo(/[ÁA]rea\s*Total:?\s*([\d.,]+)\s*m²/i),
      condominio: campo(/Condom[íi]nio\s*(?:R\$)?:?\s*R?\$?\s*([\d.,]+)/i),
      iptu: campo(/IPTU\s*R\$:?\s*([\d.,]+)/i),
      // Não há campo estruturado de banheiros: vem da descrição livre.
      banheiros: campo(/\b(\d{1,2})\s*(?:banheiros?|wcs?\b)/i) || campo(/banheiros?\s*:?\s*(\d{1,2})\b/i)
        || ({ dois: '2', duas: '2', tres: '3', 'três': '3' }[((t.match(/\b(dois|duas|tr[eê]s)\s+banheiros/i) || [])[1] || '').toLowerCase()])
        || (/banheiro|\bwc\b|su[íi]te/i.test(t) ? '1' : null),
      quartos: campo(/(\d+)\s*quartos?/i),
      vagas: campo(/(\d+)\s*vagas?/i) || campo(/vagas?(?: de garagem)?:?\s*(\d+)/i),
      publicadoHa: campo(/Publicado h[áa]:?\s*([^\n]+)/i),
      atualizado: campo(/Atualizado em:?\s*(\d{2}\/\d{2}\/\d{2,4})/i),
      det,
      cidadeBairro: [...document.querySelectorAll('h2, h3, span, p')].map((e) => e.innerText.trim()).find((x) => /^[A-ZÀ-Ú .'-]+ - [A-ZÀ-Ú0-9 .'-]+$/.test(x)) || null,
    };
  });
  if (a.area_m2 == null && d.area) a.area_m2 = num(d.area);
  a.condominio = d.condominio ? num(d.condominio) : null;
  a.iptu = d.iptu ? num(d.iptu) : null;
  if (d.banheiros) a.banheiros = num(d.banheiros);
  if (a.quartos == null && d.quartos) a.quartos = num(d.quartos);
  if (a.vagas == null && d.vagas) a.vagas = num(d.vagas);
  if (d.h1 && !a.endereco) a.endereco = d.h1;
  if (d.cidadeBairro && !a.regiao) a.regiao = regiaoPermitida(d.cidadeBairro);
  // Data: a do card é a data de cadastro ("publicado"); "Publicado há X" na página reflete a
  // última republicação/atualização. Guardamos ambas; data_publicacao usa a de cadastro se houver.
  const atual = d.atualizado ? dataBr(d.atualizado) : dataRelativa(d.publicadoHa);
  a.data_atualizacao = atual;
  if (!a.data_publicacao && atual) {
    a.data_publicacao = atual;
    a.data_tipo = 'atualizado';
  }
  return a;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium', // headless "novo": passa no Cloudflare onde o headless shell é desafiado
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
  const ctx = await browser.newContext({
    userAgent: ua,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en'] });
  });
  // Economiza banda: não baixa imagens/fontes/mídia.
  await ctx.route('**/*', (route) => {
    const t = route.request().resourceType();
    return ['image', 'media', 'font'].includes(t) ? route.abort() : route.continue();
  });

  const page = await ctx.newPage();
  const brutos = new Map();
  let bloqueado = false;

  for (const tipo of TIPOS) {
    for (let pg = 1; pg <= MAX_PAGINAS; pg++) {
      const url = `${BASE}/aluguel/df/todos/${tipo}?valorfinal=${FILTRO.precoMax}${pg > 1 ? `&pagina=${pg}` : ''}`;
      if (!(await abrir(page, url))) {
        if (pg === 1) console.warn(`  sem resultados/bloqueado em ${url}`);
        bloqueado = bloqueado || /momento|moment/i.test(await page.title().catch(() => ''));
        break;
      }
      const h1 = await page.evaluate(() => document.querySelector('h1')?.innerText || '');
      const cards = await page.evaluate(extrairCards);
      let novos = 0;
      for (const c of cards) {
        const a = parseCard(c, tipo);
        if (!brutos.has(a.link)) { brutos.set(a.link, a); novos++; }
        else if (tipo === 'casa-condominio') brutos.get(a.link).tipo = 'casa em condomínio';
      }
      console.log(`${tipo} p${pg}: ${cards.length} cards (${novos} novos) — ${h1.split('\n')[0]}`);
      if (cards.length === 0 || novos === 0) break;
      await sleep(jitter(1500, 3000));
    }
  }

  const todos = [...brutos.values()];
  // Pré-filtro com dados da listagem (evita visitar anúncios que já seriam descartados).
  const candidatos = todos.filter((a) => {
    if (!a.regiao) return false;
    if (/^(kitnet|studio|quarto|loft|flat|hotel)/i.test(a._slug)) return false;
    if (/kitchen?ette|kit\b|quitinete/i.test(a.titulo)) return false;
    return passaFiltro(a);
  });
  const porRegiao = {};
  todos.forEach((a) => { const k = a.regiao || `(fora: ${a.cidade})`; porRegiao[k] = (porRegiao[k] || 0) + 1; });
  console.log('Brutos por região:', porRegiao);
  console.log(`\nBrutos: ${todos.length} | candidatos p/ detalhe: ${candidatos.length}`);

  // Anúncios já conhecidos (KNOWN_LINKS_FILE) com o mesmo preço: reaproveita os campos, sem abrir o detalhe.
  const fila = candidatos.filter((a) => !reaproveitar(a));
  if (fila.length < candidatos.length) console.log(`Conhecidos (sem detalhe): ${candidatos.length - fila.length}; detalhes a abrir: ${fila.length}`);
  const nDetalhes = fila.length;
  // Detalhes com ~3 abas concorrentes.
  let feitos = 0;
  async function worker() {
    const p = await ctx.newPage();
    while (fila.length) {
      const a = fila.shift();
      await detalhar(p, a);
      feitos++;
      if (feitos % 20 === 0) console.log(`  detalhes: ${feitos}/${nDetalhes}`);
      if (fila.length) await sleep(jitter(3000, 5500)); // pausa só se ainda há detalhe (429)
    }
    await p.close();
  }
  await Promise.all(Array.from({ length: Math.min(CONCORRENCIA, fila.length) }, worker));

  const coletado_em = new Date().toISOString();
  const final = candidatos
    .filter((a) => a.regiao && passaFiltro(a))
    .map(({ _slug, ...a }) => ({ ...a, coletado_em }))
    .sort((x, y) => x.preco - y.preco);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(final, null, 2));
  console.log(`\nDFimóveis: ${todos.length} brutos, ${final.length} passaram no filtro${bloqueado ? ' (houve bloqueio parcial)' : ''} -> ${OUT}`);
  await browser.close();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main };
