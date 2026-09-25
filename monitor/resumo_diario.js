// Mensagem diária "estou vivo" no Telegram: quantas rodadas, anúncios checados e novos nas
// últimas 24 h, e os minutos do mês. Roda no fim do job diário (df).
const fs = require('fs');
const path = require('path');
const telegram = require('./telegram');

const linhas = fs.readFileSync(path.join(__dirname, 'state', 'execucoes.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const desde = Date.now() - 24 * 3600 * 1000;
const dia = linhas.filter((e) => !e.dry_run && !e.pulado && Date.parse(e.inicio) >= desde);
const soma = (k) => dia.reduce((s, e) => s + (e[k] || 0), 0);
const falhas = [...new Set(dia.flatMap((e) => Object.entries(e.coletores || {}).filter(([, c]) => c.erro).map(([n]) => n)))];

let minutos = '?';
try {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'state', 'minutos.json'), 'utf8'));
  minutos = (m[new Date().toISOString().slice(0, 7)] || {}).minutos ?? 0;
} catch {}

const texto = [
  '📊 <b>Resumo do dia · alerta de aluguel</b>',
  `✅ ${dia.length} rodadas nas últimas 24 h`,
  `🔎 ${soma('aprovados')} anúncios checados dentro do filtro`,
  `🆕 ${soma('notificados')} novos enviados${soma('baixas') ? ` · 📉 ${soma('baixas')} baixas de preço` : ''}`,
  falhas.length ? `⚠️ sites com erro: ${falhas.join(', ')}` : '🌐 todos os sites responderam',
  `⏱️ ${minutos}/2000 min do GitHub usados no mês`,
].join('\n');

telegram.enviar(texto).then(() => console.log(texto), (e) => { console.error('falha ao enviar resumo:', e.message); process.exit(0); });
