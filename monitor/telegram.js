// Envio de mensagens pelo Telegram Bot API.
//   enviar(texto)        -> sendMessage (HTML), com retry e respeito ao 429 (retry_after)
//   quemMandou()         -> getUpdates: lista quem mandou mensagem ao bot (só para achar o ID; não autoriza ninguém)
// Destinatários: SOMENTE os IDs de TELEGRAM_CHAT_IDS (lista fechada no .env / secrets). Sem lista,
// o envio falha: o bot nunca escolhe sozinho para quem mandar.
// Sem TELEGRAM_TOKEN (ou com setDryRun(true)) funciona em modo dry-run: só imprime no console.
//
// CLI:  node monitor/telegram.js descobrir     (mostra os IDs de quem mandou /start ao bot)
//       node monitor/telegram.js teste         (manda uma mensagem de teste para a lista)
const config = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let dryRun = !config.TELEGRAM_TOKEN;
const enviadas = []; // histórico da execução (útil para testes/log)

function setDryRun(v) { dryRun = !!v || !config.TELEGRAM_TOKEN; }
function isDryRun() { return dryRun; }

function destinatarios() { return config.TELEGRAM_CHAT_IDS; }

async function api(metodo, corpo, tentativas = 5) {
  const url = `https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/${metodo}`;
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corpo || {}), signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
      if (j.ok) return j.result;
      if (r.status === 429) { // flood control: espera o que o Telegram mandar
        const s = (j.parameters && j.parameters.retry_after) || 5;
        await sleep((s + 1) * 1000);
        continue;
      }
      ultimoErro = new Error(`Telegram ${metodo}: ${j.error_code || r.status} ${j.description || ''}`);
      if (r.status >= 400 && r.status < 500) throw ultimoErro; // erro do pedido: não adianta repetir
    } catch (e) {
      ultimoErro = e;
      if (/Telegram .*: 4\d\d/.test(e.message)) throw e;
    }
    await sleep(2000 * (i + 1));
  }
  throw ultimoErro || new Error(`Telegram ${metodo}: falhou`);
}

// Só consulta: quem mandou mensagem ao bot, com o ID, para a pessoa copiar para TELEGRAM_CHAT_IDS.
async function quemMandou() {
  if (!config.TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN não configurado no .env');
  const ups = await api('getUpdates', { allowed_updates: ['message'] });
  const chats = new Map();
  for (const u of ups) {
    const m = u.message;
    if (!m || m.chat.type !== 'private') continue;
    const nome = [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.username || '';
    chats.set(m.chat.id, { chat_id: m.chat.id, nome, autorizado: destinatarios().includes(String(m.chat.id)) });
  }
  return [...chats.values()];
}

// Envia uma mensagem (HTML). O Telegram mostra a prévia do primeiro link do texto.
async function enviar(texto, { previa = true } = {}) {
  if (texto.length > 4096) texto = texto.slice(0, 4090) + '…';
  if (dryRun) {
    enviadas.push(texto);
    console.log('\n----- [telegram dry-run] -----\n' + texto + '\n------------------------------');
    return { dryRun: true };
  }
  const ids = destinatarios();
  if (!ids.length) throw new Error('TELEGRAM_CHAT_IDS vazio: defina os IDs autorizados no .env / secrets');
  const resultados = [];
  const erros = [];
  for (const id of ids) {
    try {
      resultados.push(await api('sendMessage', {
        chat_id: id, text: texto, parse_mode: 'HTML',
        link_preview_options: { is_disabled: !previa, prefer_small_media: true },
        disable_web_page_preview: !previa, // compatibilidade com versões antigas da API
      }));
    } catch (e) { erros.push(`${id}: ${e.message}`); }
  }
  enviadas.push(texto);
  await sleep(1100); // no máx. ~1 msg/s por chat
  // Falha de um destinatário (ex.: ainda não deu /start) não impede os outros; só falha se todos falharem.
  if (!resultados.length) throw new Error(erros.join('; '));
  if (erros.length) console.error('telegram: falhou para', erros.join('; '));
  return resultados;
}

module.exports = { enviar, quemMandou, setDryRun, isDryRun, destinatarios, enviadas };

if (require.main === module) {
  const cmd = process.argv[2];
  (async () => {
    if (cmd === 'descobrir') {
      const lista = await quemMandou();
      if (!lista.length) console.log('Ninguém mandou mensagem recente ao bot. Peça para mandar /start e rode de novo.');
      for (const c of lista) console.log(`${c.chat_id}\t${c.nome}\t${c.autorizado ? 'AUTORIZADO' : 'não autorizado'}`);
      console.log('Para autorizar, coloque o ID em TELEGRAM_CHAT_IDS (separados por vírgula) no .env e nos secrets.');
    } else if (cmd === 'teste') {
      await enviar('✅ Teste do monitor de aluguéis: o bot está funcionando.');
      console.log(isDryRun() ? 'dry-run (sem TELEGRAM_TOKEN)' : 'enviado');
    } else console.log('uso: node monitor/telegram.js descobrir|teste');
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
