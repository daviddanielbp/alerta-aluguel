# Deploy do monitor de aluguéis no Google Cloud (free tier)

Roda `node monitor/run.js --grupo=ssjb` a cada 30 min e `--grupo=df` a cada 6 h numa VM **e2-micro**
do free tier, com Playwright/Chromium, systemd timers e SSH apenas via IAP.

## O que você precisa fazer manualmente

1. **Bot do Telegram**: crie com o @BotFather e preencha o `.env` da raiz (`TELEGRAM_TOKEN`, chat id etc.).
2. **Faturamento**: em <https://console.cloud.google.com/billing>, cadastre um cartão (conta de faturamento
   aberta). O free tier exige conta com faturamento ativo.
3. Ter o `gcloud` logado: `gcloud auth login` (a sessão atual desta máquina está **expirada**).

Todo o resto é feito pelos scripts.

## Passo a passo

```bash
./deploy/01_projeto.sh        # projeto + faturamento + APIs + orçamento com alertas
./deploy/02_vm.sh             # rede, firewall (só IAP), VM e2-micro e setup base (swap, Node 24, systemd)
./deploy/04_enviar_codigo.sh  # envia o código + .env, npm ci, Chromium, liga os timers
./deploy/05_status.sh         # timers, últimas execuções, memória, tráfego do mês, checagens de custo
```

Re-deploy após mudar o código: rode só o `04_enviar_codigo.sh` (idempotente; preserva `monitor/state`
da VM, a menos que `FORCAR_ESTADO=1`). Para apagar tudo: `./deploy/99_destruir.sh`
(`APAGAR_PROJETO=1` para excluir o projeto também).

| Script | Onde roda | O que faz |
|---|---|---|
| `01_projeto.sh` | seu Mac | Cria o projeto `alerta-alugueis-<6 hex>` (ou `PROJECT_ID=`), vincula à única conta de faturamento aberta (ou `BILLING_ACCOUNT=`), habilita `compute`, `iap`, `billingbudgets`, `cloudbilling`. Cria um orçamento de **R$ 5** (conta em BRL) ou **US$ 1** (conta em USD), moeda detectada automaticamente, com alertas em 50/90/100% (+100% previsto). Salva IDs em `deploy/.deploy.env`. |
| `02_vm.sh` | seu Mac | VPC própria `alerta-vpc` (sem as regras abertas da rede `default`), firewall que só aceita tcp:22 de `35.235.240.0/20` (IAP), VM `e2-micro` em `us-central1-a`, `pd-standard` 20 GB, Debian 12, **sem** service account, **sem** Ops Agent, Shielded VM. Depois envia e executa o `03 base`. |
| `03_setup_remoto.sh` | na VM (root) | `base`: swap 2 GB, pacotes, fuso, journald ≤ 100 MB, Node 24 (tarball oficial, SHA-256 conferido), usuário `alerta`, `alerta@.service` + `alerta-ssjb.timer` + `alerta-df.timer`, vnstat. `app <tar>`: rsync do código, `npm ci --omit=dev`, `playwright install-deps chromium` + `playwright install chromium`, liga timers. |
| `04_enviar_codigo.sh` | seu Mac | Empacota (sem `node_modules`, `data/`, `data_ss/`, `.git`, `deploy/`, pdf/xlsx, locks/logs temporários; **com** `.env` e `monitor/state`), envia por `gcloud compute scp --tunnel-through-iap` e roda `03 app`. |
| `05_status.sh` | seu Mac | Status da VM, discos/snapshots/IPs reservados (vigias de custo), timers, `execucoes.jsonl`, journal, memória, `vnstat -m`. |
| `99_destruir.sh` | seu Mac | Confirma digitando o nome, oferece backup do `monitor/state`, apaga VM, rede, orçamento e (opcional) o projeto. |

Detalhes do serviço: `MemoryMax=850M`, `MemorySwapMax=1536M`, `Nice=10`, `TimeoutStartSec=90min`, e um
`flock` global para que SSJB e DF **nunca rodem ao mesmo tempo** (1 GB de RAM). Timers com
`RandomizedDelaySec` (6 min no SSJB, 20 min no DF) e `Persistent=true`. Tudo parametrizável por
variáveis de ambiente no topo de cada script (`PROJECT_ID`, `ZONE`, `VM_NAME`, `DISCO_GB`, `IP_MODO`...).

## Regras do free tier (verificadas em 25/09/2026)

Fonte principal: <https://docs.cloud.google.com/free/docs/free-cloud-features> (atualizada em 2026-09-24).

- **Compute Engine**: 1 VM `e2-micro` não-preemptível/mês em `us-west1`, `us-central1` ou `us-east1`.
  O limite é por **horas** (≈ horas do mês), somando todas as e2-micro da conta de faturamento.
- **Disco**: 30 GB-mês de *standard persistent disk* (`pd-standard`). `pd-balanced`/SSD são cobrados.
- **Saída de rede (Premium)**: 1 GB/mês da América do Norte para todos os destinos, exceto China e Austrália.
- **Saída de rede (Standard Tier)**: primeiros **200 GiB/mês grátis** por conta, em todas as regiões
  (<https://cloud.google.com/vpc/network-pricing>). Por isso a VM usa `--network-tier=STANDARD`.
- **IPv4 externo — É COBRADO, mesmo na e2-micro do free tier.** Tabela oficial: "Static and ephemeral IP
  addresses in use on standard VM instances: **US$ 0,005/hora**", com free tier de apenas
  **1 hora/mês por conta** (<https://cloud.google.com/vpc/network-pricing>, seção *External IP address pricing*;
  aumento de US$ 0,004 → 0,005 em 01/02/2024: <https://cloud.google.com/vpc/pricing-announce-external-ips>).
  A página do free tier não lista IP externo entre os itens gratuitos.
- **IPv6 externo**: "You are not charged ... for external IPv6 addresses that are assigned to VM instances" (mesma página).
- **Imagens**: Debian e Ubuntu (não-Pro) são gratuitas; só RHEL, SLES, Ubuntu Pro, Windows e SQL Server são
  *premium images* pagas (<https://cloud.google.com/compute/disks-image-pricing>).
- **Snapshots**: não há free tier (~US$ 0,05/GB-mês). O `gcloud` não cria agenda de snapshot, mas **VMs criadas
  pelo console podem vir com "default snapshot schedule"** — o `05_status.sh` verifica isso.
- **Cloud Logging**: 50 GiB/projeto/mês grátis; Monitoring: métricas nativas de VM são grátis; métricas do
  **Ops Agent** são cobradas por volume (<https://cloud.google.com/stackdriver/pricing>). Não instalamos o Ops Agent
  e a VM não tem service account, então quase nada vai para o Cloud Logging. Os logs ficam no journald local.
- **IAP para SSH (TCP forwarding)**: sem custo.

## Custo mensal esperado

| Item | Modo `IP_MODO=ipv4` (padrão) | Modo `IP_MODO=ipv6` |
|---|---|---|
| e2-micro 24/7 (us-central1) | 0 | 0 |
| Disco pd-standard 20 GB | 0 | 0 |
| IPv4 externo efêmero | **~US$ 3,65** (730 h × 0,005, menos 1 h grátis) ≈ **R$ 20** | 0 (não tem) |
| IPv6 externo | — | 0 |
| Saída de rede | 0 (Standard: 200 GiB grátis) | 0 até 1 GB; depois ~US$ 0,085–0,12/GiB (Premium) |
| Logging/Monitoring | 0 | 0 |
| **Total** | **≈ US$ 3,65/mês (~R$ 20)** | **R$ 0** — mas vários sites não funcionam |

Se sua conta é nova, o crédito de US$ 300 do Free Trial cobre esse IPv4 nos primeiros 90 dias.

### Decisão sobre o IP externo

**Padrão: IPv4 externo efêmero na camada Standard (~R$ 20/mês).** Não existe forma de ter saída IPv4
para a internet de graça no GCP: sem IP externo seria preciso Cloud NAT, que é **mais caro**
(US$ 0,0014/h por VM + US$ 0,005/h pelo IP do NAT + US$ 0,045/GiB processado).

O modo `IP_MODO=ipv6` (sem IPv4 externo, IPv6 grátis) custa R$ 0, mas testei em 25/09/2026 os registros
AAAA dos hosts usados pelos coletores:

- **Com IPv6**: api.telegram.org, dfimoveis, imovelweb, zapimoveis (www e glue-api), glue-api.vivareal.com,
  chavesnamao, casamineira, netimoveis, wimoveis, lugarcerto, nodejs.org, npm, CDN do Playwright, deb.debian.org.
- **Sem IPv6 (falhariam)**: **www.olx.com.br, www.vivareal.com.br, www.quintoandar.com.br, apigw.prod.quintoandar,
  imoveis.mercadolivre.com.br, api.mercadolibre.com, loft.com.br**.

Ou seja, o modo IPv6 só serve se você aceitar perder OLX, VivaReal (site), QuintoAndar, Mercado Livre e Loft.
Por isso o orçamento de **R$ 5 vai disparar alertas todo mês no modo IPv4** — se quiser só alertas de
"algo anormal", crie o orçamento com `BUDGET_VALOR=30 ./deploy/01_projeto.sh`.

## Riscos e cuidados

- **Orçamento não é teto**: o budget só manda e-mail; nada é desligado automaticamente.
- **Só 1 e2-micro grátis por conta de faturamento** (horas somadas entre projetos). Uma segunda VM/projeto na
  mesma conta é cobrada.
- **Não aumente o disco acima de 30 GB** nem troque para `pd-balanced`; não crie snapshots/imagens.
- **Não use região fora de us-west1/us-central1/us-east1** (o `02` recusa).
- **Memória**: e2-micro tem 1 GB. Chromium + Node cabe com swap de 2 GB e um grupo por vez, mas coletores pesados
  podem ficar lentos; se o journal mostrar `oom-kill`, reduza o paralelismo no monitor.
- **Bloqueio anti-bot**: IPs de datacenter (GCP) costumam ser mais desafiados por Cloudflare/Akamai do que o IP
  residencial usado nos testes. Acompanhe `execucoes.jsonl` no `05_status.sh` nos primeiros dias.
- **Saída de rede**: com Standard Tier o limite grátis (200 GiB) é folgado. `vnstat -m` (no `05`) mostra o `tx`
  real do mês. A medição do monitor fica em `monitor/medicao_trafego.json`.
- **`.env` vai para a VM** (permissão 600, dono `alerta`). Quem tem acesso ao projeto GCP consegue lê-lo.
- **Credenciais**: SSH só via IAP com OS Login; nenhuma porta aberta para a internet.
- O IPv4 efêmero pode mudar se a VM for parada/iniciada — não afeta o monitor (só faz conexões de saída).
