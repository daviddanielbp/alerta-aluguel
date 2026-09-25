// Anúncios já conhecidos (execução anterior) -> pular a página de detalhe.
//
// Env KNOWN_LINKS_FILE = caminho de um JSON:
//   { "<link normalizado>": { preco, area_m2, quartos, banheiros, vagas, condominio, iptu,
//                             data_publicacao, data_tipo, endereco, cep, lat, lon }, ... }
// Opcionais: titulo, tipo (usados por outros.js/ss_jb_b.js, onde esses campos vêm da página do anúncio).
// (também aceita um array de anúncios com campo `link`, ex.: data/*.json, que é convertido).
// Se o anúncio da listagem tem link conhecido E o mesmo preço, o crawler copia esses campos
// e não abre o detalhe. Sem o arquivo (ou arquivo inválido) nada muda.
const fs = require('fs');

const CAMPOS = ['area_m2', 'quartos', 'banheiros', 'vagas', 'condominio', 'iptu',
  'data_publicacao', 'data_tipo', 'endereco', 'cep', 'lat', 'lon'];

// Remove query (?...), fragmento (#...) e barra final.
function normalizarLink(link) {
  if (!link) return '';
  return String(link).trim().split('#')[0].split('?')[0].replace(/\/+$/, '');
}

let cache = null;
let arquivoCache = null;
function carregarConhecidos(arquivo = process.env.KNOWN_LINKS_FILE) {
  if (!arquivo) return (cache = new Map());
  if (cache && arquivoCache === arquivo) return cache;
  arquivoCache = arquivo;
  cache = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    const pares = Array.isArray(j) ? j.filter((a) => a && a.link).map((a) => [a.link, a]) : Object.entries(j || {});
    for (const [k, v] of pares) if (v && typeof v === 'object') cache.set(normalizarLink(k), v);
  } catch (e) {
    console.warn(`[known] KNOWN_LINKS_FILE ignorado (${arquivo}): ${e.message}`);
  }
  return cache;
}

// Registro conhecido para o anúncio (mesmo link normalizado e mesmo preço) ou null.
function conhecido(anuncio) {
  const mapa = carregarConhecidos();
  if (!mapa.size || !anuncio || !anuncio.link || anuncio.preco == null) return null;
  const k = mapa.get(normalizarLink(anuncio.link));
  if (!k || k.preco == null || Number(k.preco) !== Number(anuncio.preco)) return null;
  return k;
}

// Se conhecido com o mesmo preço: copia os campos (os não nulos do JSON) para o anúncio e devolve true.
// O crawler então NÃO abre o detalhe. Caso contrário devolve false e nada é alterado.
function reaproveitar(anuncio) {
  const k = conhecido(anuncio);
  if (!k) return false;
  for (const c of CAMPOS) if (k[c] !== undefined && k[c] !== null) anuncio[c] = k[c];
  reaproveitar.total = (reaproveitar.total || 0) + 1;
  return true;
}

module.exports = { normalizarLink, carregarConhecidos, conhecido, reaproveitar, CAMPOS };
