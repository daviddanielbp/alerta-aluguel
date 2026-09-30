# Monitor de aluguéis → Telegram

Roda os crawlers, aplica o filtro (≤ `PRECO_MAX`, ≥1 quarto, ≥1 banheiro, ≥40 m² ou área desconhecida,
sem kitnet/studio/comercial/temporada, regiões de `scrapers/common.js`) e avisa no Telegram só os
anúncios **novos** e as **baixas de preço**.

## Configuração (variáveis de ambiente ou `.env` na raiz; o ambiente tem prioridade)

```
TELEGRAM_TOKEN=123456:ABC...        # do @BotFather (sem token = dry-run automático)
TELEGRAM_CHAT_IDS=111,222           # OBRIGATÓRIO: só estes chats recebem mensagens (ache o ID com: node monitor/telegram.js descobrir)
PRECO_MAX=1200
REGIOES_ALERTA=todas                # ou: São Sebastião, Jardim Botânico, Asa Norte
RAIO_QUENTE_KM=1.5                  # São Sebastião até essa distância do terminal ganha 🔥
FREQ_SSJB_MIN=30                    # usados por --cron
FREQ_DF_MIN=180
BLOQUEAR_RECURSOS=1                 # usa monitor/instrument.js (se existir) p/ bloquear imagens etc.
# TIMEOUT_OLX_MIN=40                # timeout por coletor (padrões em config.js)
```

## Comandos

```bash
node monitor/telegram.js descobrir               # após mandar /start ao bot: salva o chat_id
node monitor/telegram.js teste                   # mensagem de teste

node monitor/run.js --grupo=ssjb --seed          # 1ª vez: marca tudo como visto, manda 1 resumo
node monitor/run.js --grupo=df   --seed
node monitor/run.js --grupo=ssjb                 # rodadas normais (avisa só o que é novo)
node monitor/run.js --grupo=df
node monitor/run.js --grupo=todos --dry-run      # sem Telegram: imprime as mensagens
node monitor/run.js --grupo=df --coletores=olx,dfimoveis --dry-run   # só alguns coletores
node monitor/run.js --cron                       # imprime as linhas do crontab
```

Grupos: `ssjb` = `scrapers/ss_jb_a.js` + `ss_jb_b.js` (São Sebastião/Jardim Botânico);
`df` = olx, dfimoveis, imovelweb, zap_vivareal, quintoandar, chaves_mercadolivre, outros; `todos` = ambos.

## Como funciona

- Cada coletor roda em **processo filho**, um de cada vez (VM de 1 GB), com timeout e isolamento de erro.
  Os crawlers do DF são copiados para `state/work/<x>/` e gravam lá — `data/` do projeto não é tocado.
- Normalização/dedupe = `merge.js` (ZAP/VivaReal mesmo id; mesmo imóvel em portais diferentes por
  preço+área+quartos+região).
- Estado em `state/vistos.json` (chaves: link normalizado / `zap:id` / `id:site:id` + chave fuzzy).
  Anúncio de um site que nunca tinha retornado nada entra sem aviso (evita enxurrada quando um site volta).
- São Sebastião/Jardim Botânico: geocodificação (Nominatim/ViaCEP, cache `state/geocache.json`) e
  distância ao Terminal Rodoviário de São Sebastião.
- Mais de 15 avisos numa rodada → agrupados em poucas mensagens.
- `state/execucoes.jsonl`: log por execução (duração, brutos/aprovados/erro/pico de RAM por coletor,
  tráfego quando `instrument.js` está disponível). `state/logs/<coletor>.log`: saída do último run.
- `state/run.lock` impede duas instâncias ao mesmo tempo (rodada concorrente é pulada e registrada).

Para "reavisar" um anúncio (teste): apague a entrada dele em `state/vistos.json` → `itens`.

## GitHub Actions

- Secrets `TELEGRAM_TOKEN` e `TELEGRAM_CHAT_IDS` viram variáveis de ambiente do job (têm prioridade sobre o `.env`).
- Sem token o monitor roda em dry-run (avisa no log e só imprime as mensagens).
- Passos típicos do job: `npm ci` → `npx playwright install --with-deps chromium` →
  `npm run monitor:ssjb` (ou `monitor:df`) → commit de `monitor/state/{vistos.json,geocache.json,execucoes.jsonl}`.
- Estado determinístico: chaves ordenadas, datas só `YYYY-MM-DD` (fuso de Brasília), `execucoes.jsonl`
  limitado às últimas 300 linhas. O que é volátil (work/, logs/, run.lock) está no `.gitignore`.
- Funciona em checkout limpo: não precisa de `data/` nem `data_ss/` (tudo é gravado em `state/work/`).
- Opcional: cachear `monitor/.cache_http/` (scripts/CSS dos portais) com `actions/cache` para baixar menos.
- `npm run monitor:seed` = `--grupo=todos --seed` (semeia tudo antes do primeiro cron).
