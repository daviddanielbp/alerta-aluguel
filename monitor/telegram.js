// Envio de mensagens pelo Telegram Bot API.
//   enviar(texto)        -> sendMessage (HTML), com retry e respeito ao 429 (retry_after)
//   descobrirChatId()    -> getUpdates: pega o chat de quem mandou /start ao bot e salva em state/telegram.json
// Sem TELEGRAM_TOKEN (ou com setDryRun(true)) funciona em modo dry-run: só imprime no console.
//
// CLI:  node monitor/telegram.js descobrir     (depois de mandar /start ao bot)
//       node monitor/telegram.js teste         (manda uma mensagem de teste)
const fs = require('fs');
const path = require('path');
const config = require('./config');

const STATE_FILE = path.join(config.STATE_DIR, 'telegram.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let dryRun = !config.TELEGRAM_TOKEN;
const enviadas = []; // histórico da execução (útil para testes/log)

function setDryRun(v) { dryRun = !!v || !config.TELEGRAM_TOKEN; }
function isDryRun() { return dryRun; }

function lerEstado() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function chatId() { return config.TELEGRAM_CHAT_ID || lerEstado().chat_id || null; }

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

async function descobrirChatId() {
  if (!config.TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN não configurado no .env');
  const ups = await api('getUpdates', { allowed_updates: ['message'] });
  const msgs = ups.map((u) => u.message || u.channel_post).filter(Boolean);
  const alvo = msgs.reverse().find((m) => /^\/start/.test(m.text || '')) || msgs[0];
  if (!alvo) throw new Error('Nenhuma mensagem encontrada. Mande /start para o bot no Telegram e tente de novo.');
  const est = { chat_id: alvo.chat.id, nome: [alvo.chat.first_name, alvo.chat.last_name].filter(Boolean).join(' ') || alvo.chat.title || alvo.chat.username || null, descoberto_em: new Date().toISOString() };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(est, null, 2));
  return est;
}

// Envia uma mensagem (HTML). O Telegram mostra a prévia do primeiro link do texto.
async function enviar(texto, { previa = true } = {}) {
  if (texto.length > 4096) texto = texto.slice(0, 4090) + '…';
  if (dryRun) {
    enviadas.push(texto);
    console.log('\n----- [telegram dry-run] -----\n' + texto + '\n------------------------------');
    return { dryRun: true };
  }
  let id = chatId();
  if (!id) id = (await descobrirChatId()).chat_id;
  const r = await api('sendMessage', {
    chat_id: id, text: texto, parse_mode: 'HTML',
    link_preview_options: { is_disabled: !previa, prefer_small_media: true },
    disable_web_page_preview: !previa, // compatibilidade com versões antigas da API
  });
  enviadas.push(texto);
  await sleep(1100); // no máx. ~1 msg/s por chat
  return r;
}

module.exports = { enviar, descobrirChatId, setDryRun, isDryRun, chatId, enviadas };

if (require.main === module) {
  const cmd = process.argv[2];
  (async () => {
    if (cmd === 'descobrir') {
      const e = await descobrirChatId();
      console.log('chat_id salvo em', STATE_FILE, e);
    } else if (cmd === 'teste') {
      await enviar('✅ Teste do monitor de aluguéis: o bot está funcionando.');
      console.log(isDryRun() ? 'dry-run (sem TELEGRAM_TOKEN)' : 'enviado');
    } else console.log('uso: node monitor/telegram.js descobrir|teste');
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
