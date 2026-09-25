// Geocodificação (Nominatim + ViaCEP, com cache) e distância ao Terminal Rodoviário de São Sebastião.
// Extraído de ss_jb_merge.js para uso no monitor. Cache em monitor/state/geocache.json
// (na primeira vez é inicializado com uma cópia do geocache.json da raiz).
const fs = require('fs');
const path = require('path');

const TERMINAL = { lat: -15.9133454, lon: -47.7573464 };
const UA = 'cidades-proximas-unb-monitor/1.0 (admin@mvgois.com)';
const CACHE_FILE = path.join(__dirname, 'state', 'geocache.json');
const CACHE_RAIZ = path.join(__dirname, '..', 'geocache.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cache = null;
let sujo = false;
function carregarCache() {
  if (cache) return cache;
  try {
    if (!fs.existsSync(CACHE_FILE) && fs.existsSync(CACHE_RAIZ)) {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.copyFileSync(CACHE_RAIZ, CACHE_FILE);
    }
    cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
  } catch { cache = {}; }
  return cache;
}
function salvarCache() {
  if (!cache || !sujo) return;
  const tmp = CACHE_FILE + '.tmp';
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  // chaves ordenadas: arquivo determinístico (é commitado pelo GitHub Actions)
  const ord = Object.fromEntries(Object.keys(cache).sort().map((k) => [k, cache[k]]));
  fs.writeFileSync(tmp, JSON.stringify(ord, null, 1) + '\n');
  fs.renameSync(tmp, CACHE_FILE);
  sujo = false;
}

function distKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Minutos a pé estimados: distância em linha reta x 1,4 (fator de desvio das ruas) a 5 km/h.
const minutosAPe = (km) => Math.max(1, Math.round((km * 1.4 / 5) * 60));

let ultimaNominatim = 0;
async function nominatim(q) {
  const c = carregarCache();
  if (q in c) return c[q];
  const espera = 1100 - (Date.now() - ultimaNominatim); // política de uso do Nominatim: 1 req/s
  if (espera > 0) await sleep(espera);
  ultimaNominatim = Date.now();
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=' + encodeURIComponent(q);
  let res;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null; // erro HTTP: não cacheia, tenta de novo na próxima
    res = await r.json();
  } catch { return null; }
  const hit = res[0] ? { lat: +res[0].lat, lon: +res[0].lon, fonte: q } : null;
  c[q] = hit; sujo = true;
  return hit;
}

async function viacep(cep) {
  const c = carregarCache();
  const k = 'cep:' + cep;
  if (k in c) return c[k];
  let j;
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    j = await r.json();
  } catch { return null; }
  c[k] = j && !j.erro ? j : null; sujo = true;
  return c[k];
}

// Tenta, do mais preciso ao menos preciso: endereço do anúncio, logradouro do CEP, CEP, bairro.
async function geocodificar(a) {
  const cidade = a.regiao === 'Jardim Botânico' ? 'Jardim Botânico' : 'São Sebastião';
  const cep = String(a.cep || '').replace(/\D/g, '');
  const tentativas = [];
  if (a.endereco) tentativas.push(`${a.endereco.split(/,\s*(São Sebasti|Brasília|DF)/i)[0]}, ${cidade}, Distrito Federal`);
  if (cep.length === 8) {
    const v = await viacep(cep);
    if (v && v.logradouro) tentativas.push(`${v.logradouro}, ${v.bairro || ''}, ${cidade}, Distrito Federal`);
    tentativas.push(`${cep.slice(0, 5)}-${cep.slice(5)}, Brasil`);
  }
  if (a.bairro) tentativas.push(`${a.bairro}, ${cidade}, Distrito Federal`);
  for (const q of tentativas) {
    const g = await nominatim(q);
    // descarta resultados que caem longe demais da região (geocodificação errada)
    if (g && distKm(g, TERMINAL) < 12) return { ...g, precisao: q === tentativas[tentativas.length - 1] && a.bairro ? 'bairro' : 'endereço/CEP' };
  }
  return null;
}

// Preenche a.lat/a.lon/a.geo_precisao/a.dist_terminal_km (usa a coordenada do anúncio se for exata).
async function localizar(a) {
  if (a.lat != null && a.lon != null && !a.geo_aprox) a.geo_precisao = 'anúncio';
  else {
    const g = await geocodificar(a).catch(() => null);
    if (g) { a.lat = g.lat; a.lon = g.lon; a.geo_precisao = g.precisao; }
    else if (a.lat != null) a.geo_precisao = 'aproximada (portal)';
  }
  a.dist_terminal_km = a.lat != null ? +distKm(a, TERMINAL).toFixed(2) : null;
  return a;
}

module.exports = { TERMINAL, distKm, minutosAPe, nominatim, viacep, geocodificar, localizar, salvarCache, carregarCache };
