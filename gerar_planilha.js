// Gera alugueis_unb.xlsx (importável no Google Sheets) a partir de resultado.json.
const ExcelJS = require('exceljs');
const r = require('./resultado.json');
const corte = '2026-08-25';

const wb = new ExcelJS.Workbook();
const FONT = { name: 'Arial', size: 10 };
const HEAD = { font: { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A5FB4' } } };

const grupo = (a) => (a.area_m2 == null ? '3. Sem área informada' : a.data_publicacao >= corte ? '1. Últimos 30 dias' : '2. Mais antigo');
const lista = [...r].sort((x, y) => grupo(x).localeCompare(grupo(y)) || x.preco - y.preco);

const ws = wb.addWorksheet('Imóveis', { views: [{ state: 'frozen', ySplit: 1 }] });
ws.columns = [
  { header: '#', key: 'n', width: 5 },
  { header: 'Grupo', key: 'grupo', width: 20 },
  { header: 'Aluguel (R$)', key: 'preco', width: 12, style: { numFmt: '#,##0' } },
  { header: 'Condomínio (R$)', key: 'cond', width: 14, style: { numFmt: '#,##0' } },
  { header: 'Região', key: 'regiao', width: 18 },
  { header: 'Bairro', key: 'bairro', width: 30 },
  { header: 'Tipo', key: 'tipo', width: 7 },
  { header: 'm²', key: 'area', width: 6 },
  { header: 'Quartos', key: 'q', width: 8 },
  { header: 'Banheiros', key: 'b', width: 10 },
  { header: 'Vagas', key: 'v', width: 7 },
  { header: '~Min até UnB', key: 'min', width: 12 },
  { header: 'Publicado', key: 'data', width: 11, style: { numFmt: 'dd/mm/yyyy' } },
  { header: 'Site', key: 'site', width: 13 },
  { header: 'Link', key: 'link', width: 16 },
  { header: 'Outros links (mesmo imóvel)', key: 'outros', width: 60 },
  { header: 'Título do anúncio', key: 'titulo', width: 60 },
];
lista.forEach((a, i) => {
  const row = ws.addRow({
    n: i + 1, grupo: grupo(a), preco: a.preco, cond: a.condominio > 0 ? a.condominio : null,
    regiao: a.regiao, bairro: a.bairro || '', tipo: /casa/i.test(a.tipo) ? 'Casa' : 'Apto',
    area: a.area_m2, q: a.quartos, b: a.banheiros, v: a.vagas ?? 0, min: a.tempo_unb_min,
    data: a.data_publicacao ? new Date(a.data_publicacao + 'T12:00:00Z') : null, site: a.site,
    link: { text: 'Abrir anúncio', hyperlink: a.link },
    outros: (a.outros_links || []).join('  '), titulo: (a.titulo || '').trim(),
  });
  row.font = FONT;
  row.getCell('link').font = { ...FONT, color: { argb: 'FF1A5FB4' }, underline: true };
  if (a.regiao === 'Vila Planalto') row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
});
ws.getRow(1).eachCell((c) => Object.assign(c, HEAD));
['n', 'area', 'q', 'b', 'v', 'min', 'tipo'].forEach((k) => (ws.getColumn(k).alignment = { horizontal: 'center' }));
ws.autoFilter = { from: 'A1', to: 'Q1' };

const ss = require('fs').existsSync('resultado_ss_jb.json') ? require('./resultado_ss_jb.json') : [];
const wss = wb.addWorksheet('São Sebastião (terminal)', { views: [{ state: 'frozen', ySplit: 1 }] });
wss.columns = [
  { header: '#', key: 'n', width: 5 },
  { header: 'Distância do terminal (km)', key: 'd', width: 14, style: { numFmt: '0.00' } },
  { header: '~Min a pé', key: 'pe', width: 10 },
  { header: 'Precisão', key: 'p', width: 14 },
  { header: 'Aluguel (R$)', key: 'preco', width: 12, style: { numFmt: '#,##0' } },
  { header: 'Condomínio (R$)', key: 'cond', width: 14, style: { numFmt: '#,##0' } },
  { header: 'Bairro', key: 'bairro', width: 28 },
  { header: 'Tipo', key: 'tipo', width: 7 },
  { header: 'm²', key: 'area', width: 6 },
  { header: 'Quartos', key: 'q', width: 8 },
  { header: 'Banheiros', key: 'b', width: 10 },
  { header: 'Vagas', key: 'v', width: 7 },
  { header: 'Publicado', key: 'data', width: 11, style: { numFmt: 'dd/mm/yyyy' } },
  { header: 'Site', key: 'site', width: 12 },
  { header: 'Link', key: 'link', width: 16 },
  { header: 'Outros links (mesmo imóvel)', key: 'outros', width: 60 },
  { header: 'Título do anúncio', key: 'titulo', width: 60 },
];
ss.forEach((a, i) => {
  const row = wss.addRow({
    n: i + 1, d: a.dist_terminal_km, pe: a.dist_terminal_km == null ? null : Math.max(1, Math.round(a.dist_terminal_km * 1.3 / 5 * 60)),
    p: a.geo_precisao === 'bairro' ? '~centro do bairro' : a.geo_precisao, preco: a.preco, cond: a.condominio > 0 ? a.condominio : null,
    bairro: (a.bairro || '').replace(/\s*\(São Sebasti[aã]o\)/i, ''), tipo: /casa/i.test(a.tipo) ? 'Casa' : 'Apto',
    area: a.area_m2, q: a.quartos, b: a.banheiros, v: a.vagas ?? 0,
    data: a.data_publicacao ? new Date(a.data_publicacao + 'T12:00:00Z') : null, site: a.site,
    link: { text: 'Abrir anúncio', hyperlink: a.link }, outros: (a.outros_links || []).join('  '), titulo: (a.titulo || '').trim(),
  });
  row.font = FONT;
  row.getCell('link').font = { ...FONT, color: { argb: 'FF1A5FB4' }, underline: true };
});
wss.getRow(1).eachCell((c) => Object.assign(c, HEAD));
['n', 'd', 'pe', 'area', 'q', 'b', 'v', 'tipo'].forEach((k) => (wss.getColumn(k).alignment = { horizontal: 'center' }));
wss.autoFilter = { from: 'A1', to: 'Q1' };
const nota = wss.addRow([]); wss.addRow(['', 'Terminal Rodoviário de São Sebastião: Rua 1, Bela Vista (-15.9133, -47.7573). Distância em linha reta; "a pé" = ×1,3 a 5 km/h.']).font = FONT;
wss.addRow(['', 'Jardim Botânico (inclui Mangueiral e Tororó): nenhum imóvel até R$ 1.200 em nenhum site nesta varredura.']).font = FONT;

const wr = wb.addWorksheet('Regiões');
wr.columns = [{ header: 'Tempo até a UnB (estimado)', key: 't', width: 26 }, { header: 'Regiões', key: 'r', width: 110 }];
[['até ~20 min', 'Vila Planalto, Asa Norte, Noroeste'],
 ['~25–35 min', 'Varjão, Lago Norte, Asa Sul, Granja do Torto, Cruzeiro, Sudoeste/Octogonal, Vila Telebrasília, Paranoá, Lago Sul'],
 ['~40–50 min', 'Itapoã, Guará, Estrutural/SCIA, Candangolândia, Núcleo Bandeirante, Park Way, Jardim Botânico, Grande Colorado, Sobradinho'],
 ['~55–60 min', 'Riacho Fundo I/II, Águas Claras, Vicente Pires, São Sebastião, Taguatinga'],
].forEach(([t, x]) => wr.addRow({ t, r: x }).font = FONT);
wr.getRow(1).eachCell((c) => Object.assign(c, HEAD));
[[],
 ['Observações'],
 ['Varredura', '24/09/2026 · aluguel ≤ R$ 1.200, ≥ 1 quarto, ≥ 1 banheiro, ≥ 40 m², sem kitnet/studio/quarto avulso'],
 ['Tempos', 'Estimativas de ônibus/metrô, não medidas. Ceilândia, Samambaia, Recanto, Gama e cidades de Goiás ficaram fora (>1h).'],
 ['Vila Planalto', 'Nenhum anúncio online dentro do filtro nesta varredura (linhas da Vila Planalto aparecem destacadas em amarelo quando houver).'],
 ['Sites', 'OLX, DFimóveis, ZAP, VivaReal, ImovelWeb, Wimoveis, QuintoAndar, Chaves na Mão, Lugar Certo, Loft, Casa Mineira, Netimóveis. Mercado Livre bloqueou (exige login).'],
 ['Publicado', 'Data informada pelo portal; alguns mostram a data de cadastro original, que pode ser antiga mesmo com o anúncio ativo.'],
].forEach((row) => { const x = wr.addRow(row); x.font = FONT; });
wr.getCell('A7').font = { ...FONT, bold: true };

wb.xlsx.writeFile('alugueis_unb.xlsx').then(() => console.log('ok', lista.length));
