// Trava de orçamento dos minutos do GitHub Actions (repo privado: 2.000 min/mês grátis).
//
// O GitHub cobra cada job arredondando para cima em minutos inteiros. Este script mantém a
// contagem em monitor/state/minutos.json (versionado junto com o estado) e decide se o job
// deve rodar:
//
//   node monitor/orcamento.js checar --grupo=ssjb     -> escreve rodar=true|false em $GITHUB_OUTPUT
//   node monitor/orcamento.js registrar --inicio=<epoch s>
//   node monitor/orcamento.js status
//
// Regras:
//   - ssjb para de rodar ao atingir LIMITE_SSJB; df para ao atingir LIMITE_DF.
//   - Ritmo: se a projeção do mês (uso / fração do mês decorrida) passar de LIMITE_SSJB,
//     o ssjb roda só em metade dos horários, até a projeção voltar ao normal.
//   - A margem até 2.000 cobre jobs pulados (cada um ainda custa ~1 min) e erros de medição.
const fs = require('fs');
const path = require('path');

const LIMITE_GRATIS = 2000;
const LIMITE_SSJB = Number(process.env.LIMITE_SSJB || 1750);
const LIMITE_DF = Number(process.env.LIMITE_DF || 1850);
const ARQ = path.join(__dirname, 'state', 'minutos.json');

const args = Object.fromEntries(process.argv.slice(3).map((a) => a.replace(/^--/, '').split('=')));
const agora = new Date();
const mes = agora.toISOString().slice(0, 7); // o ciclo do GitHub vira no dia 1º (UTC)

function ler() {
  try { return JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { return {}; }
}
function salvar(dados) {
  // mantém só os últimos 6 meses, chaves ordenadas (diff estável no git)
  const ordenado = Object.fromEntries(Object.keys(dados).sort().slice(-6).map((k) => [k, dados[k]]));
  fs.mkdirSync(path.dirname(ARQ), { recursive: true });
  fs.writeFileSync(ARQ, JSON.stringify(ordenado, null, 2) + '\n');
}
function fracaoDoMes() {
  const ini = Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1);
  const fim = Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() + 1, 1);
  return Math.max((agora - ini) / (fim - ini), 1 / 60); // evita projeções absurdas no 1º dia
}
function saida(chave, valor) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${chave}=${valor}\n`);
  console.log(`${chave}=${valor}`);
}

const dados = ler();
const atual = dados[mes] || { minutos: 0, jobs: 0 };
const cmd = process.argv[2];

if (cmd === 'checar') {
  const grupo = args.grupo || 'ssjb';
  const projecao = Math.round(atual.minutos / fracaoDoMes());
  let rodar = true;
  let motivo = 'ok';
  if (grupo === 'df' && atual.minutos >= LIMITE_DF) { rodar = false; motivo = `limite df (${atual.minutos}/${LIMITE_DF})`; }
  if (grupo !== 'df') {
    if (atual.minutos >= LIMITE_SSJB) { rodar = false; motivo = `limite ssjb (${atual.minutos}/${LIMITE_SSJB})`; }
    else if (projecao > LIMITE_SSJB && agora.getUTCHours() % 4 >= 2) { rodar = false; motivo = `ritmo: projeção ${projecao} min > ${LIMITE_SSJB}`; }
  }
  console.log(`[orçamento] ${mes}: ${atual.minutos} min em ${atual.jobs} jobs · projeção ${projecao} min · ${grupo}: ${rodar ? 'RODA' : 'PULA'} (${motivo})`);
  saida('rodar', rodar);
  saida('minutos_mes', atual.minutos);
  saida('esgotado', grupo !== 'df' && atual.minutos >= LIMITE_SSJB);
} else if (cmd === 'registrar') {
  const inicio = Number(args.inicio);
  if (!inicio) { console.error('uso: registrar --inicio=<epoch em segundos>'); process.exit(1); }
  // arredonda para cima como o GitHub e soma 1 min de folga (provisionamento/pós-job)
  const min = Math.ceil((Date.now() / 1000 - inicio) / 60) + 1;
  dados[mes] = { minutos: atual.minutos + min, jobs: atual.jobs + 1 };
  salvar(dados);
  console.log(`[orçamento] +${min} min → ${dados[mes].minutos}/${LIMITE_GRATIS} em ${mes}`);
} else if (cmd === 'status') {
  console.log(`[orçamento] ${mes}: ${atual.minutos}/${LIMITE_GRATIS} min · ${atual.jobs} jobs · projeção ${Math.round(atual.minutos / fracaoDoMes())} min`);
} else {
  console.error('uso: node monitor/orcamento.js checar|registrar|status [--grupo=ssjb|df] [--inicio=epoch]');
  process.exit(1);
}
