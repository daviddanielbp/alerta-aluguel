// Configuração compartilhada por todos os crawlers.
// Regiões do DF com trajeto até a UnB (Campus Darcy Ribeiro) de até ~1h em transporte público/carro.
const REGIOES = [
  'Asa Norte', 'Asa Sul', 'Vila Planalto', 'Noroeste', 'Lago Norte', 'Varjão', 'Taquari',
  'Paranoá', 'Itapoã', 'Cruzeiro', 'Sudoeste', 'Octogonal', 'Guará', 'Núcleo Bandeirante',
  'Candangolândia', 'Riacho Fundo', 'Park Way', 'Sobradinho', 'SCIA', 'Estrutural',
  'São Sebastião', 'Jardim Botânico', 'Lago Sul', 'Taguatinga', 'Águas Claras',
  'Vicente Pires', 'Grande Colorado', 'Setor de Indústria e Abastecimento', 'Vila Telebrasília', 'Granja do Torto',
];

const FILTRO = { precoMax: 1200, areaMin: 40, quartosMin: 1, banheirosMin: 1 };

const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Retorna o nome canônico da região se o texto (bairro/cidade/endereço) bater com alguma permitida.
function regiaoPermitida(texto) {
  const t = norm(texto);
  for (const r of REGIOES) if (t.includes(norm(r))) return r;
  return null;
}

// Aplica o filtro do usuário. Área desconhecida -> mantém, mas marcado (area_m2: null).
function passaFiltro(a) {
  if (a.preco == null || a.preco <= 0 || a.preco > FILTRO.precoMax) return false;
  if (a.area_m2 != null && a.area_m2 < FILTRO.areaMin) return false;
  if (a.quartos != null && a.quartos < FILTRO.quartosMin) return false;
  if (a.banheiros != null && a.banheiros < FILTRO.banheirosMin) return false;
  if (/kit ?net|kitinete|studio|est[uú]dio|quarto (individual|mobiliado|para estudante|em casa)|vaga (em|para)|divid/i.test(a.titulo || '')) return false;
  return true;
}

module.exports = { REGIOES, FILTRO, norm, regiaoPermitida, passaFiltro };
