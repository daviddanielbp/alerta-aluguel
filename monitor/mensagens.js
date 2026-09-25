// Formatação das mensagens do Telegram (HTML).
const geo = require('./geo');
const config = require('./config');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const brl = (n) => 'R$ ' + Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const km = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const ddmm = (iso) => { const m = String(iso || '').match(/^\d{4}-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[1]}` : null; };
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;

const TIPOS = [[/apart|apto|flat/i, 'Apto'], [/casa|sobrado/i, 'Casa'], [/cobertura/i, 'Cobertura']];
const tipoCurto = (t) => { for (const [re, n] of TIPOS) if (re.test(t || '')) return n; return t ? String(t)[0].toUpperCase() + String(t).slice(1).toLowerCase() : 'Imóvel'; };

const SITES = [
  [/olx\.com/, 'OLX'], [/zapimoveis/, 'ZAP'], [/vivareal/, 'VivaReal'], [/dfimoveis/, 'DFimóveis'],
  [/imovelweb/, 'ImovelWeb'], [/wimoveis/, 'Wimoveis'], [/quintoandar/, 'QuintoAndar'], [/chavesnamao/, 'Chaves na Mão'],
  [/mercadolivre/, 'Mercado Livre'], [/loft\.com/, 'Loft'], [/lugarcerto/, 'Lugar Certo'], [/casamineira/, 'Casa Mineira'],
  [/netimoveis/, 'Netimóveis'],
];
const siteDe = (link, fallback) => { for (const [re, n] of SITES) if (re.test(link || '')) return n; return fallback || 'anúncio'; };

const quente = (a) => a.regiao === 'São Sebastião' && a.dist_terminal_km != null && a.dist_terminal_km <= config.RAIO_QUENTE_KM;

function localTexto(a) {
  if ((a.regiao === 'São Sebastião' || a.regiao === 'Jardim Botânico') && a.dist_terminal_km != null) {
    const aprox = a.geo_precisao === 'bairro' || /aproximada/.test(a.geo_precisao || '') ? '≈' : '';
    const d = a.dist_terminal_km;
    return `${aprox}${km(d)} km do terminal` + (d <= 4 ? ` (~${geo.minutosAPe(d)} min a pé)` : '');
  }
  if (a.regiao === 'São Sebastião') return 'distância ao terminal desconhecida';
  return a.tempo_unb_min != null ? `~${a.tempo_unb_min} min até a UnB` : null;
}

// "Quadra 3 Conjunto B, , Sobradinho, Brasília, DF" -> "Quadra 3 Conjunto B, Sobradinho"
const limparEndereco = (e) => (e ? String(e).replace(/(,\s*)+,/g, ',').replace(/(,\s*(Brasília|DF|Distrito Federal|Brasil))+\s*$/i, '').replace(/^[,\s]+|[,\s]+$/g, '') : null);

function linksExtras(a) {
  const extras = [...new Set([a.link_alt, a.link_vivareal, ...(a.outros_links || [])].filter((l) => l && l !== a.link))];
  return extras.map((l) => `<a href="${esc(l)}">${esc(siteDe(l))}</a>`);
}

function linhaPreco(a) {
  let s = `💰 <b>${brl(a.preco)}</b>`;
  if (a.condominio) s += ` (+ ${brl(a.condominio)} cond.)`;
  if (a._evento === 'baixou') s += ` · antes <s>${brl(a._preco_anterior)}</s>`;
  return s;
}

function linhaImovel(a) {
  const p = [tipoCurto(a.tipo), a.area_m2 != null ? `${a.area_m2} m²` : '? m²'];
  if (a.quartos != null) p.push(plural(a.quartos, 'quarto', 'quartos'));
  if (a.banheiros != null) p.push(plural(a.banheiros, 'banheiro', 'banheiros'));
  if (a.vagas) p.push(plural(a.vagas, 'vaga', 'vagas'));
  return '🏠 ' + p.join(' · ');
}

function cabecalho(a) {
  const ev = a._evento === 'baixou' ? 'BAIXOU DE PREÇO' : 'NOVO';
  const emoji = a._evento === 'baixou' ? (quente(a) ? '🔥📉' : '📉') : quente(a) ? '🔥' : '🆕';
  return [`${emoji} <b>${ev}</b>`, esc(a.regiao), localTexto(a)].filter(Boolean).join(' · ');
}

// Mensagem completa de um anúncio.
function mensagemAnuncio(a) {
  const l = [cabecalho(a), linhaPreco(a), linhaImovel(a)];
  const onde = a.bairro && a.bairro.toLowerCase() !== (a.regiao || '').toLowerCase() ? a.bairro : limparEndereco(a.endereco) || a.bairro;
  if (onde) l.push('📍 ' + esc(String(onde).slice(0, 90)));
  const d = ddmm(a.data_publicacao);
  if (d) l.push(`📅 ${a.data_tipo === 'atualizado' ? 'atualizado' : 'publicado'} ${d}`);
  const ex = linksExtras(a);
  l.push(`🔗 <a href="${esc(a.link)}">Abrir no ${esc(siteDe(a.link, a.site))}</a>` + (ex.length ? ' · também: ' + ex.join(', ') : ''));
  return l.join('\n');
}

// Versão compacta (para agrupar muitas ofertas numa só mensagem).
function blocoCompacto(a) {
  const emoji = a._evento === 'baixou' ? '📉' : quente(a) ? '🔥' : '🆕';
  const loc = localTexto(a);
  const partes = [tipoCurto(a.tipo), a.area_m2 != null ? `${a.area_m2} m²` : null, a.quartos != null ? `${a.quartos}q` : null].filter(Boolean).join(' ');
  const preco = `<b>${brl(a.preco)}</b>` + (a.condominio ? ` +${brl(a.condominio)}` : '') + (a._evento === 'baixou' ? ` (antes ${brl(a._preco_anterior)})` : '');
  const l1 = `${emoji} ${preco} · ${esc(partes)} · ${esc(a.regiao)}${loc && !/desconhecida/.test(loc) ? ' · ' + loc.replace(/ \(~.*\)$/, '') : ''}`;
  const d = ddmm(a.data_publicacao);
  const l2 = [a.bairro ? '📍 ' + esc(String(a.bairro).slice(0, 40)) : null, d ? `📅 ${d}` : null,
    `<a href="${esc(a.link)}">${esc(siteDe(a.link, a.site))}</a>`].filter(Boolean).join(' · ');
  return `${l1}\n${l2}`;
}

// Ordena: 🔥 primeiro, depois São Sebastião por distância, depois preço.
function ordenar(lista) {
  return [...lista].sort((x, y) => quente(y) - quente(x)
    || (x.regiao === 'São Sebastião' ? 0 : 1) - (y.regiao === 'São Sebastião' ? 0 : 1)
    || (x.dist_terminal_km ?? 99) - (y.dist_terminal_km ?? 99) || x.preco - y.preco);
}

// Lista de { texto, itens } a enviar. Poucos -> uma mensagem por anúncio; muitos -> agrupados (<= 4096 chars).
function montar(eventos, { limiteIndividuais = config.LIMITE_INDIVIDUAIS } = {}) {
  const ord = ordenar(eventos);
  if (ord.length <= limiteIndividuais) return ord.map((a) => ({ texto: mensagemAnuncio(a), itens: [a] }));
  const novos = ord.filter((a) => a._evento !== 'baixou').length;
  const baixas = ord.length - novos;
  const titulo = [novos ? plural(novos, 'imóvel novo', 'imóveis novos') : null, baixas ? plural(baixas, 'baixa de preço', 'baixas de preço') : null].filter(Boolean).join(' + ');
  const LIM = 3900;
  const partes = [];
  let atual = { blocos: [], itens: [], tam: 0 };
  for (const a of ord) {
    const b = blocoCompacto(a);
    if (atual.blocos.length && atual.tam + b.length + 2 > LIM) { partes.push(atual); atual = { blocos: [], itens: [], tam: 0 }; }
    atual.blocos.push(b); atual.itens.push(a); atual.tam += b.length + 2;
  }
  if (atual.blocos.length) partes.push(atual);
  return partes.map((p, i) => ({
    texto: `📬 <b>${titulo}</b>${partes.length > 1 ? ` (${i + 1}/${partes.length})` : ''}\n\n` + p.blocos.join('\n\n'),
    itens: p.itens,
  }));
}

module.exports = { montar, mensagemAnuncio, blocoCompacto, esc, brl, plural, quente };
