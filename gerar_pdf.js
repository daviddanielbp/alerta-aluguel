// Gera relatorio_alugueis_unb.pdf a partir de resultado.json (links clicáveis).
const fs = require('fs');
const { chromium } = require('playwright');
const r = require('./resultado.json');
const ss = fs.existsSync('resultado_ss_jb.json') ? require('./resultado_ss_jb.json') : [];
// linha reta x1,3 (desvio de ruas) a 5 km/h
const aPe = (km) => (km == null ? '?' : Math.max(1, Math.round((km * 1.3 / 5) * 60)));

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const brl = (n) => (n == null || n <= 0 ? '' : 'R$ ' + Number(n).toLocaleString('pt-BR'));
const dt = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '?');
const hoje = '2026-09-24';
const corte = '2026-08-25';

const tabela = (lista) => `<table><thead><tr><th>#</th><th class="n">Aluguel</th><th class="n">Cond.</th><th>Região</th><th>Bairro</th><th>Tipo</th><th class="c">m²</th><th class="c">Quartos</th><th class="c">Banheiros</th><th class="c">Vagas</th><th class="c">~min UnB</th><th>Publicado</th><th>Link</th></tr></thead><tbody>
${lista.map((a, i) => `<tr><td>${i + 1}</td><td class="n"><b>${brl(a.preco)}</b></td><td class="n">${brl(a.condominio)}</td><td>${esc(a.regiao)}</td><td class="bairro">${esc((a.bairro || '').slice(0, 28))}</td><td>${/casa/i.test(a.tipo) ? 'Casa' : 'Apto'}</td><td class="c">${a.area_m2 ?? '?'}</td><td class="c">${a.quartos ?? '?'}</td><td class="c">${a.banheiros ?? '?'}</td><td class="c">${a.vagas ?? 0}</td><td class="c">${a.tempo_unb_min ?? '?'}</td><td>${dt(a.data_publicacao)}</td><td><a href="${esc(a.link)}">${esc(a.site)}</a>${(a.outros_links || []).map((l, j) => ` <a class="alt" href="${esc(l)}">[${j + 2}]</a>`).join('')}</td></tr>`).join('\n')}
</tbody></table>`;

const recentes = r.filter((a) => a.area_m2 != null && a.data_publicacao >= corte);
const antigos = r.filter((a) => a.area_m2 != null && !(a.data_publicacao >= corte));
const semArea = r.filter((a) => a.area_m2 == null);

const regioes = [
  ['até ~20 min', 'Vila Planalto, Asa Norte, Noroeste'],
  ['~25–35 min', 'Varjão, Lago Norte, Asa Sul, Granja do Torto, Cruzeiro, Sudoeste/Octogonal, Vila Telebrasília, Paranoá, Lago Sul'],
  ['~40–50 min', 'Itapoã, Guará, Estrutural/SCIA, Candangolândia, Núcleo Bandeirante, Park Way, Jardim Botânico, Grande Colorado, Sobradinho'],
  ['~55–60 min', 'Riacho Fundo I/II, Águas Claras, Vicente Pires, São Sebastião, Taguatinga'],
];

const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
body{font-family:-apple-system,Helvetica,Arial,sans-serif;color:#1a1a1a;font-size:9px;margin:0}
h1{font-size:18px;margin:0 0 2px} h2{font-size:13px;margin:16px 0 4px;border-bottom:2px solid #1a5fb4;padding-bottom:2px}
.sub{color:#555;font-size:10px;margin-bottom:8px} p,li{font-size:9.5px;line-height:1.4}
table{border-collapse:collapse;width:100%} th,td{border-bottom:1px solid #ddd;padding:2.5px 4px;text-align:left;vertical-align:top}
th{background:#eef3fb;font-size:8.5px} tr:nth-child(even) td{background:#fafafa} td.n{text-align:right;white-space:nowrap}
td.c,th.c{text-align:center} th.n{text-align:right} td.bairro{color:#555} a{color:#1a5fb4;font-weight:600;text-decoration:none} a.alt{font-weight:400;font-size:8px}
.reg td{font-size:9.5px} .box{background:#fff6e0;border-left:3px solid #e5a50a;padding:5px 8px;margin:6px 0}
thead{display:table-header-group} tr{page-break-inside:avoid}
</style></head><body>
<h1>Aluguéis perto da UnB · até R$ 1.200</h1>
<div class="sub">Varredura de ${dt(hoje)} · filtro: aluguel ≤ R$ 1.200, ≥ 1 quarto, ≥ 1 banheiro, ≥ 40 m², sem kitnet/studio/quarto avulso · ${r.length} imóveis únicos</div>

<h2>Regiões a até ~1h da UnB (Campus Darcy Ribeiro)</h2>
<table class="reg">${regioes.map(([t, n]) => `<tr><td style="width:90px"><b>${t}</b></td><td>${n}</td></tr>`).join('')}</table>
<p style="color:#555">Tempos estimados de ônibus/metrô (não medidos). Ceilândia, Samambaia, Recanto, Gama e cidades de Goiás ficaram fora (&gt;1h).</p>
<div class="box"><b>Vila Planalto:</b> nenhum anúncio online dentro do filtro. Plano Piloto (Asa Norte/Sul) também não. Um anúncio "Asa Norte" de R$ 1.199 era na verdade no Itapoã Parque e foi corrigido.</div>
<p><b>Sites varridos:</b> OLX, DFimóveis, ZAP, VivaReal, ImovelWeb, Wimoveis, QuintoAndar, Chaves na Mão, Lugar Certo, Loft, Casa Mineira, Netimóveis. Mercado Livre bloqueou (exige login).<br>
<b>Como ler:</b> "?" = o anúncio não informa · clique no nome do site para abrir o anúncio; [2], [3]… são o mesmo imóvel em outros portais · "Publicado" é a data que o portal informa (alguns portais mostram a data de cadastro original, que pode ser antiga mesmo com o anúncio ativo).</p>

<h2>★ São Sebastião — ordenado pela distância até o Terminal Rodoviário (${ss.length})</h2>
<p style="color:#555">Terminal: Rua 1, Bela Vista. Distância em linha reta; "a pé" estima o trajeto real (×1,3 a 5 km/h). Precisão: <b>anúncio</b> = coordenada do portal · <b>endereço/CEP</b> = geocodificado · <b>~bairro</b> = centro do bairro (menos preciso). <b>Jardim Botânico:</b> nenhum imóvel até R$ 1.200 em nenhum site.</p>
<table><thead><tr><th>#</th><th class="c">Dist. terminal</th><th class="c">A pé</th><th>Precisão</th><th class="n">Aluguel</th><th class="n">Cond.</th><th>Bairro</th><th>Tipo</th><th class="c">m²</th><th class="c">Quartos</th><th class="c">Banheiros</th><th class="c">Vagas</th><th>Publicado</th><th>Link</th></tr></thead><tbody>
${ss.map((a, i) => `<tr><td>${i + 1}</td><td class="c"><b>${a.dist_terminal_km == null ? '?' : a.dist_terminal_km.toLocaleString('pt-BR') + ' km'}</b></td><td class="c">~${aPe(a.dist_terminal_km)} min</td><td>${a.geo_precisao === 'bairro' ? '~bairro' : esc(a.geo_precisao || '?')}</td><td class="n"><b>${brl(a.preco)}</b></td><td class="n">${brl(a.condominio)}</td><td class="bairro">${esc((a.bairro || '').replace(/\s*\(São Sebasti[aã]o\)/i, '').slice(0, 28))}</td><td>${/casa/i.test(a.tipo) ? 'Casa' : 'Apto'}</td><td class="c">${a.area_m2 ?? '?'}</td><td class="c">${a.quartos ?? '?'}</td><td class="c">${a.banheiros ?? '?'}</td><td class="c">${a.vagas ?? 0}</td><td>${dt(a.data_publicacao)}</td><td><a href="${esc(a.link)}">${esc(a.site)}</a>${(a.outros_links || []).map((l, j) => ` <a class="alt" href="${esc(l)}">[${j + 2}]</a>`).join('')}</td></tr>`).join('\n')}
</tbody></table>

<h2>1. Publicados nos últimos 30 dias (${recentes.length}) — mais chance de estarem disponíveis</h2>
${tabela(recentes)}
<h2>2. Anúncios mais antigos (${antigos.length}) — podem já ter sido alugados</h2>
${tabela(antigos)}
<h2>3. Sem área informada no anúncio (${semArea.length}) — confira os m² antes de visitar</h2>
${tabela(semArea)}
</body></html>`;

fs.writeFileSync('relatorio.html', html);
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent(html, { waitUntil: 'load' });
  await p.pdf({ path: 'relatorio_alugueis_unb.pdf', format: 'A4', landscape: true, printBackground: true,
    margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#888">página <span class="pageNumber"></span> de <span class="totalPages"></span></div>' });
  await b.close();
  console.log('ok', recentes.length, antigos.length, semArea.length);
})();
