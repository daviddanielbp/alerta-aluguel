# Medição de tráfego e tempo dos coletores

Medido em 25/09/2026 num Mac (rede residencial, Brasília) com `node monitor/medir_trafego.js`.
Dados brutos: `monitor/medicao_trafego.json` (inclui hosts e tipos de recurso por execução). Logs e
saídas de cada execução: `monitor/_runs/`.

- **SEM** = crawler original, sem nenhuma interferência. Alguns crawlers já abortam imagens/fontes por conta
  própria.
- **COM** = `monitor/instrument.js` ativo (o mesmo que `monitor/coletores/preload.js` usa em produção), com o
  cache de scripts **frio** (1ª execução).
- **MB** = headers + corpos HTTP (Playwright `request.sizes()` + undici para o `fetch` do Node). O valor
  "fio" (nettop, que inclui TLS/TCP) fica 5–10% acima e está no JSON.
- **anúncios** = anúncios aprovados gravados pelo crawler.

## Resultado

| coletor | grupo | req SEM | req COM | saída MB SEM → COM | entrada MB SEM → COM | anúncios SEM / COM | tempo s SEM → COM |
|---|---|---:|---:|---:|---:|---:|---:|
| ss_jb_a | ssjb | 9 139 | 191 | 17,48 → 0,27 | 189,9 → 7,8 | 12 / 12 | 454 → 303 |
| ss_jb_b | ssjb | 5 402 | 198 | 4,87 → 0,16 | 71,4 → 8,2 | 4 / 4 | 302 → 124 |
| olx | df | 10 885 | 253 | 18,97 → 0,23 | 626,3 → 19,5 | 171 / 171 | 225 → 160 |
| dfimoveis | df | 22 067 | 345 | 59,75 → 0,19 | 593,9 → 7,0 | 100 / 100 | 1108 → 190 |
| imovelweb | df | 3 515 | 123 | 6,92 → 0,17 | 44,5 → 8,8 | 78 / 78 | 415 → 280 |
| zap_vivareal | df | 713 | 16 | 0,93 → 0,04 | 10,4 → 0,2 | 114 / 114 | 27 → 22 |
| quintoandar | df | 6 | 6 | 0,00 → 0,00 | 0,23 → 0,23 | 5 / 5 | 5 → 4 |
| chaves_mercadolivre | df | 1 478 | 22 | 1,04 → 0,03 | 14,3 → 0,8 | 5 / 5 | 11 → 9 |
| outros | df | 3 429 | 89 | 2,96 → 0,06 | 75,0 → 6,6 | 35 / 35 | 63 → 53 |
| **grupo ssjb** | | 14 541 | 389 | 22,4 → 0,43 | 261 → 15,9 | 16 / 16 | 756 → 427 (7,1 min) |
| **grupo df** | | 42 093 | 854 | 90,6 → 0,74 | 1 365 → 43,1 | 508 / 508 | 1854 → 718 (12,0 min) |

Por execução, o bloqueio reduz a entrada em cerca de 94% (ssjb) e 97% (df), e a saída em cerca de 98–99%.
No DFimóveis e na OLX o tempo cai 3–6 vezes, porque o Chromium deixa de executar anúncios, trackers e bundles JS.

**Nenhum site perdeu anúncios.** Os conjuntos de links SEM e COM são idênticos em todos os coletores. A
única exceção é o imovelweb: 11 links aparecem só num lado e 11 só no outro. São os **mesmos imóveis**
(mesmo ID), publicados ao mesmo tempo no imovelweb.com.br e no wimoveis.com.br. A deduplicação fica com a
URL de um ou do outro portal conforme a ordem de chegada. Não houve perda.

Observações:
- A 1ª execução SEM bloqueio da OLX, rodando em paralelo com dfimoveis e imovelweb, derrubou o Chromium
  (`Target crashed` / `Invalid InterceptionId` do Playwright) depois de baixar 720 MB em 587 s. A linha da
  tabela é de uma nova execução isolada. Sem bloqueio, a OLX é pesada o bastante para quebrar o navegador.
- O dfimoveis COM foi medido de novo depois de um ajuste no cache (ver abaixo): a 1ª medição COM deu
  41,5 MB de entrada, 35,6 MB dos quais eram o JS do reCAPTCHA baixado 100 vezes.
- DFimóveis e ss_jb_a (que também consulta o DFimóveis) nunca rodaram ao mesmo tempo. Houve 20 s de
  pausa entre SEM e COM e nenhum 429 apareceu.

## O que é bloqueado (`monitor/instrument.js`)

1. **Tipos de recurso**: image, media, font, stylesheet, manifest, texttrack, ping/beacon e relatórios CSP.
2. **Hosts de ads, analytics e widgets** (cerca de 200 sufixos): Google Ads, GTM e GA, DoubleClick, pixels do
   Facebook, TikTok, Kwai e Pinterest, Hotjar, Clarity, New Relic, Datadog RUM, Sentry, Criteo, Taboola,
   RTB (rubicon, pubmatic, adnxs…), consentimento (OneTrust, goadopt), chats (Zendesk, Blip…),
   YouTube e Maps, e ainda os trackers próprios dos portais (`lurker.olx`, `cdn.track.zapimoveis/vivareal`,
   `observability.chavesnamao`).
3. **JS próprio dos portais com HTML SSR** (olx, chavesnamao, imovelweb/wimoveis/naventcdn, dfimoveis,
   netimoveis, zap/vivareal/grupozap, lugarcerto, mercadolivre, casamineira). Esses crawlers leem o
   HTML/DOM ou chamam a API interna.
4. **Nunca bloqueados**: desafios anti-bot (Cloudflare `/cdn-cgi/`, turnstile, reCAPTCHA, hCaptcha,
   DataDome, PerimeterX, Akamai, Incapsula).
5. **Cache persistente de scripts e CSS** (`monitor/.cache_http`, até 300 MB, com poda automática). Com
   `route()` ativo o Chromium desliga o cache HTTP, e o instrument serve de disco os estáticos versionados.
   **Ajuste feito nesta medição:** o JS versionado do reCAPTCHA (`www.gstatic.com/recaptcha/releases/<hash>/…`,
   ~350 KB, `max-age=1 ano`) agora pode ir para o cache. Ele continua carregando normalmente, só que vem do
   disco. Com isso o dfimoveis caiu de 41,5 para 7,0 MB por execução, com os mesmos 100 anúncios.

Não foi preciso afrouxar o bloqueio em nenhum site: `CSS_PERMITIDO` continua vazio e `SEM_JS` está completo.

## Estimativa mensal no GitHub Actions

Premissas:
- 30 dias.
- `run.js` roda os coletores do grupo **em sequência** num job.
- Job = soma dos tempos COM + ~1,5 min de overhead (checkout, `npm ci` com cache, Chromium com cache de
  `~/.cache/ms-playwright`), arredondado para cima porque o GitHub cobra por job em minutos inteiros.
- **ssjb ≈ 9 min/job e df ≈ 14 min/job.**

| cenário | jobs/mês | minutos de Actions/mês | entrada (download) | saída (upload) |
|---|---|---:|---:|---:|
| **(a)** ssjb a cada 30 min + df a cada 6 h | 1 440 + 120 | **≈ 14 600** (12 960 + 1 680) | **≈ 30 GB** | **≈ 1,1 GB** |
| **(b)** ssjb a cada 60 min + df a cada 12 h | 720 + 60 | **≈ 7 300** (6 480 + 840) | **≈ 15 GB** | **≈ 0,5 GB** |
| (a) sem bloqueio, só para comparação | | ≈ 26 000 | ≈ 600 GB | ≈ 50 GB |

- **Repo público**: minutos ilimitados em runners padrão. Os dois cenários cabem.
- **Repo privado (2 000 min/mês)**: (a) passa em ~12 600 min e (b) em ~5 300 min. Na tabela Linux 2-core
  (≈ US$ 0,006/min, confira o preço atual) isso dá ≈ US$ 75/mês em (a) e ≈ US$ 32/mês em (b). Para caber
  em 2 000 min, o ssjb teria de rodar no máximo a cada ~2,5 h com o df a cada 12 h, ou seria preciso
  aplicar as otimizações abaixo.
- O tráfego de rede não é cobrado no Actions. Os GB importam para educação com os sites e para
  rate-limit, não para custo.
- Cuidados:
  - Os runners ficam nos EUA (Azure). A latência até os portais brasileiros é maior, e IP de datacenter tem
    mais chance de receber desafio Cloudflare (OLX) ou 429 (DFimóveis). Conte com tempos **1,2–1,5 vezes
    maiores** que os medidos: (a) ≈ 18–21 mil min e (b) ≈ 9–10 mil min.
  - O cron do Actions atrasa com frequência (5–30 min) e pode pular execuções em horário de pico.
  - Em repo público, os workflows agendados são desativados depois de 60 dias sem atividade no repo.
    Um commit do estado (`monitor/state/`) a cada execução evita isso.
  - Use `concurrency: { group: monitor-${{ grupo }}, cancel-in-progress: false }` para não sobrepor jobs.
  - Persista `monitor/.cache_http` com `actions/cache`. Senão cada job começa com o cache frio e baixa de
    novo os bundles JS. É pouco (as medições acima já são com cache frio), mas economiza alguns MB e segundos.

## Otimizações sugeridas (não implementadas nos crawlers)

Em ordem de ganho estimado:

1. **Pular páginas de detalhe de anúncios já vistos** (maior ganho no grupo df). DFimóveis (100 detalhes,
   com pausa de 3–5,5 s cada, 3 abas: cerca de 2/3 dos 190 s), OLX (171 detalhes, 226 documentos,
   17,5 MB) e outros/casamineira e lugarcerto (≈ 60 detalhes) abrem o anúncio só para completar
   data, área e descrição. O `monitor/state/vistos.json` já tem esses links. Basta passar ao crawler um
   conjunto de "links conhecidos com preço igual" para ele reaproveitar os campos do estado e só abrir o
   detalhe de anúncios novos ou com preço alterado. Numa execução em regime, a maioria dos anúncios já foi
   vista, e o df deve cair de ~12 para ~4–5 min. O mesmo vale para o OLX/DFimóveis dentro do ss_jb_a.
2. **ImovelWeb e Wimoveis são o mesmo backend (Navent) com os mesmos anúncios.** No df, 686 brutos viram
   343 únicos (exatamente a metade) e o total do filtro é idêntico (295/48) nos dois portais. Varrer só um
   deles corta ~50% do imovelweb (280 → ~140 s). No ss_jb_a o problema é pior: o ImovelWeb percorre
   **84 páginas / 2 398 brutos** do DF inteiro para aprovar **1** anúncio em SS/JB. Usar a URL/filtro de
   localização (São Sebastião / Jardim Botânico) em vez de varrer o DF e filtrar localmente reduz o ss_jb_a
   de ~300 s para ~120 s. Isso pesa porque o ssjb é o job que mais roda (1 440 vezes/mês em (a)).
3. **Varreduras "DF inteiro" dentro do ssjb.** O ss_jb_a também percorre `OLX apartamentos/DF` e
   `casas/DF` (41 páginas no total) e acha **0 candidatos novos** além das buscas por bairro. No ss_jb_b,
   Loft (217 brutos), Lugar Certo (269) e Casa Mineira (209) dão 0 anúncios na região. Rodar essas
   varreduras amplas só no job df (a cada 6/12 h), e no ssjb só as buscas por bairro, deve levar o ssjb para
   ~3–4 min + overhead. Com isso (a) fica em ≈ 8 000 min/mês.
4. **Pausas fixas.** As esperas aleatórias (imovelweb 6–9 s entre tipos, 2,5–5 s na abertura; DFimóveis
   3–5,5 s por detalhe; ZAP 3–5 s) somam boa parte do tempo. Onde não há rate-limit observado
   (imovelweb via `fetch` interno, zap), dá para reduzir à metade. No DFimóveis, manter as pausas, porque ele
   devolve 429.
5. **Juntar os grupos quando coincidem.** Nos horários em que df e ssjb caem juntos, rodar um job só evita
   pagar o overhead duas vezes e reaproveita o cache do Chromium e do npm. Também dá para rodar o ssjb
   dentro do job df e pular o ssjb daquela hora.
6. **Overhead do job.** Cachear `~/.cache/ms-playwright` com a versão do Playwright na chave, instalar só
   `chromium-headless-shell` (`npx playwright install --only-shell chromium`, ~100 MB a menos que o
   Chromium completo) e usar `npm ci --omit=dev` (o `exceljs` não é usado pelo monitor). Assim o overhead
   fica perto de 1 min.
