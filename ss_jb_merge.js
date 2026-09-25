// Junta São Sebastião + Jardim Botânico (data_ss/*.json + resultado.json), geocodifica
// o que não tem coordenada e ordena São Sebastião pela distância ao Terminal Rodoviário.
const fs = require('fs');
const path = require('path');

const TERMINAL = { lat: -15.9133454, lon: -47.7573464 };
const UA = 'cidades-proximas-unb/1.0 (admin@mvgois.com)';
const CACHE_FILE = 'geocache.json';
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function distKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function nominatim(q) {
  if (q in cache) return cache[q];
  await sleep(1100); // política de uso do Nominatim: 1 req/s
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=' + encodeURIComponent(q);
  const res = await fetch(url, { headers: { 'User-Agent': UA } }).then((r) => r.json()).catch(() => []);
  const hit = res[0] ? { lat: +res[0].lat, lon: +res[0].lon, fonte: q } : null;
  cache[q] = hit;
  return hit;
}

async function viacep(cep) {
  const k = 'cep:' + cep;
  if (k in cache) return cache[k];
  const j = await fetch(`https://viacep.com.br/ws/${cep}/json/`).then((r) => r.json()).catch(() => null);
  cache[k] = j && !j.erro ? j : null;
  return cache[k];
}

// Tenta, do mais preciso ao menos preciso: endereço do anúncio, logradouro do CEP, bairro.
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

(async () => {
  const brutos = [];
  if (fs.existsSync('data_ss')) for (const f of fs.readdirSync('data_ss').filter((f) => /^ss_jb_.*\.json$/.test(f)))
    brutos.push(...JSON.parse(fs.readFileSync(path.join('data_ss', f), 'utf8')));
  brutos.push(...require('./resultado.json').filter((a) => ['São Sebastião', 'Jardim Botânico'].includes(a.regiao)));

  const vistos = new Map(); // chave -> anúncio já guardado
  const lista = [];
  for (const a of brutos) {
    const ids = [a.link, ...(a.outros_links || []), a.link_vivareal].filter(Boolean);
    const gid = (a.link.match(/zapimoveis|vivareal/) && a.link.match(/id-(\d+)/)) ? 'zap:' + a.link.match(/id-(\d+)/)[1] : null;
    const chave = [a.preco, a.area_m2, a.quartos, a.regiao].join('|');
    const chaves = [...ids, gid, a.area_m2 != null ? chave : null].filter(Boolean);
    const dono = chaves.map((k) => vistos.get(k)).find(Boolean);
    if (dono) {
      // mesmo imóvel: guarda os links extras e completa o que faltar
      dono.outros_links = [...new Set([...(dono.outros_links || []), ...ids])].filter((l) => l !== dono.link);
      for (const k of ['lat', 'lon', 'cep', 'endereco', 'area_m2', 'condominio', 'banheiros', 'vagas']) if (dono[k] == null && a[k] != null) dono[k] = a[k];
      chaves.forEach((k) => vistos.set(k, dono));
      continue;
    }
    a.outros_links = ids.slice(1);
    chaves.forEach((k) => vistos.set(k, a));
    lista.push(a);
  }

  for (const a of lista) {
    if (a.lat != null && a.lon != null && !a.geo_aprox) { a.geo_precisao = 'anúncio'; continue; }
    const g = await geocodificar(a);
    if (g) { a.lat = g.lat; a.lon = g.lon; a.geo_precisao = g.precisao; }
    else if (a.lat != null) a.geo_precisao = 'aproximada (portal)';
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));

  for (const a of lista) if (a.condominio != null && (a.condominio <= 0 || a.condominio === a.preco)) a.condominio = null;
  for (const a of lista) a.dist_terminal_km = a.lat != null ? +distKm(a, TERMINAL).toFixed(2) : null;
  lista.sort((x, y) => (x.regiao === 'São Sebastião' ? 0 : 1) - (y.regiao === 'São Sebastião' ? 0 : 1)
    || (x.dist_terminal_km ?? 99) - (y.dist_terminal_km ?? 99) || x.preco - y.preco);
  fs.writeFileSync('resultado_ss_jb.json', JSON.stringify(lista, null, 2));
  for (const a of lista) console.log(a.regiao.slice(0, 5), a.dist_terminal_km ?? '?', 'km', a.geo_precisao || '-', '| R$', a.preco, a.area_m2, 'm² |', (a.bairro || '').slice(0, 25), '|', a.link);
})();
