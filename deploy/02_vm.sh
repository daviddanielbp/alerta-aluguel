#!/usr/bin/env bash
# 02 - Cria rede, firewall (só SSH via IAP) e a VM e2-micro do free tier; depois roda o setup remoto (03).
# Uso:  ./deploy/02_vm.sh
#       IP_MODO=ipv6 ./deploy/02_vm.sh      (sem IPv4 externo: grátis, mas vários sites falham — ver README)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_comum.sh"
carregar_estado

# ---------------- Variáveis ----------------
PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"             # free tier: us-west1, us-central1 ou us-east1
ZONE="${ZONE:-${REGION}-a}"
VM_NAME="${VM_NAME:-alerta-alugueis}"
MACHINE_TYPE="e2-micro"                     # NÃO mude: só e2-micro é free tier
DISCO_GB="${DISCO_GB:-20}"                  # free tier: até 30 GB-mês de pd-standard (somando TODOS os discos)
IMAGEM_FAMILIA="${IMAGEM_FAMILIA:-debian-12}"
IMAGEM_PROJETO="${IMAGEM_PROJETO:-debian-cloud}"
IP_MODO="${IP_MODO:-ipv4}"                  # ipv4 (padrão, ~US$3,65/mês) | ipv6 (grátis, sites sem IPv6 falham)
REDE="${REDE:-alerta-vpc}"
SUBREDE="${SUBREDE:-alerta-subnet}"
SUBREDE_RANGE="${SUBREDE_RANGE:-10.10.0.0/24}"
TAG_SSH="alerta-iap-ssh"
IAP_RANGE="35.235.240.0/20"                 # faixa fixa do Google IAP TCP forwarding
RODAR_SETUP="${RODAR_SETUP:-1}"             # 1 = já executa o 03_setup_remoto.sh na VM
# -------------------------------------------

checar_gcloud
exigir_projeto
case "$REGION" in us-west1|us-central1|us-east1) ;; *) erro "Região $REGION NÃO é free tier (use us-west1, us-central1 ou us-east1)." ;; esac
[[ "$ZONE" == "$REGION"-* ]] || erro "ZONE ($ZONE) não pertence à REGION ($REGION)."
[[ "$DISCO_GB" -ge 10 && "$DISCO_GB" -le 30 ]] || erro "DISCO_GB deve ficar entre 10 e 30."
case "$IP_MODO" in ipv4|ipv6) ;; *) erro "IP_MODO deve ser ipv4 ou ipv6." ;; esac
G=(--project="$PROJECT_ID")

# Aviso se já existir outra e2-micro (as horas grátis são por conta, somadas).
OUTRAS="$(gcloud compute instances list "${G[@]}" --filter="machineType~e2-micro AND name!=$VM_NAME" --format='value(name)' 2>/dev/null || true)"
[[ -z "$OUTRAS" ]] || aviso "Já existem outras e2-micro neste projeto ($OUTRAS). O free tier cobre só ~730 h/mês no total."

# 1) Rede VPC própria (modo custom) — evita as regras permissivas da rede 'default'
if gcloud compute networks describe "$REDE" "${G[@]}" >/dev/null 2>&1; then
  ok "Rede $REDE já existe."
else
  msg "Criando rede $REDE ..."
  gcloud compute networks create "$REDE" "${G[@]}" --subnet-mode=custom
fi

if gcloud compute networks subnets describe "$SUBREDE" "${G[@]}" --region="$REGION" >/dev/null 2>&1; then
  ok "Sub-rede $SUBREDE já existe."
else
  msg "Criando sub-rede $SUBREDE (dual-stack; IPv6 externo não é cobrado) ..."
  gcloud compute networks subnets create "$SUBREDE" "${G[@]}" \
    --network="$REDE" --region="$REGION" --range="$SUBREDE_RANGE" \
    --stack-type=IPV4_IPV6 --ipv6-access-type=EXTERNAL
fi

# 2) Firewall: entrada SOMENTE SSH vindo do IAP. Saída liberada (regra implícita).
if gcloud compute firewall-rules describe "${REDE}-allow-iap-ssh" "${G[@]}" >/dev/null 2>&1; then
  ok "Regra de firewall ${REDE}-allow-iap-ssh já existe."
else
  msg "Criando regra de firewall (tcp:22 somente de $IAP_RANGE) ..."
  gcloud compute firewall-rules create "${REDE}-allow-iap-ssh" "${G[@]}" \
    --network="$REDE" --direction=INGRESS --action=ALLOW --rules=tcp:22 \
    --source-ranges="$IAP_RANGE" --target-tags="$TAG_SSH" \
    --description="SSH apenas via IAP (gcloud compute ssh --tunnel-through-iap)"
fi

# 3) VM
if [[ "$IP_MODO" == "ipv4" ]]; then
  # IPv4 externo efêmero na camada STANDARD: 200 GiB/mês de saída grátis (Premium teria só 1 GB).
  REDE_FLAGS=(--stack-type=IPV4_ONLY --network-tier=STANDARD)
else
  # Sem IPv4 externo (IPv4 só interno) + IPv6 externo gratuito (camada Premium é obrigatória p/ IPv6).
  REDE_FLAGS=(--stack-type=IPV4_IPV6 --no-address --ipv6-network-tier=PREMIUM)
fi

if gcloud compute instances describe "$VM_NAME" "${G[@]}" --zone="$ZONE" >/dev/null 2>&1; then
  ok "VM $VM_NAME já existe (não recriada)."
else
  msg "Criando VM $VM_NAME ($MACHINE_TYPE, $ZONE, pd-standard ${DISCO_GB}GB, $IMAGEM_FAMILIA, IP_MODO=$IP_MODO) ..."
  gcloud compute instances create "$VM_NAME" "${G[@]}" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --provisioning-model=STANDARD \
    --maintenance-policy=MIGRATE \
    --image-family="$IMAGEM_FAMILIA" --image-project="$IMAGEM_PROJETO" \
    --boot-disk-type=pd-standard --boot-disk-size="${DISCO_GB}GB" --boot-disk-auto-delete \
    --subnet="$SUBREDE" "${REDE_FLAGS[@]}" \
    --tags="$TAG_SSH" \
    --no-service-account --no-scopes \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --labels=app=alerta-alugueis \
    --metadata=enable-oslogin=TRUE
fi
salvar_estado ZONE "$ZONE"
salvar_estado VM_NAME "$VM_NAME"
salvar_estado IP_MODO "$IP_MODO"

# 4) Checagens de custo: nenhum snapshot agendado nem disco extra
POLITICAS="$(gcloud compute disks describe "$VM_NAME" "${G[@]}" --zone="$ZONE" --format='value(resourcePolicies)' 2>/dev/null || true)"
[[ -z "$POLITICAS" ]] || aviso "O disco tem política de snapshot anexada ($POLITICAS) — snapshots são cobrados. Remova com: gcloud compute disks remove-resource-policies $VM_NAME --zone=$ZONE --resource-policies=..."

# 5) Setup remoto
if [[ "$RODAR_SETUP" == "1" ]]; then
  msg "Aguardando SSH via IAP ficar disponível ..."
  for i in $(seq 1 20); do
    if vm_ssh "true" >/dev/null 2>&1; then break; fi
    [[ "$i" -eq 20 ]] && erro "SSH não respondeu. Tente depois: RODAR_SETUP=1 ./deploy/02_vm.sh"
    sleep 15
  done
  msg "Enviando e executando 03_setup_remoto.sh na VM ..."
  vm_scp "$DEPLOY_DIR/03_setup_remoto.sh" "/tmp/03_setup_remoto.sh"
  vm_ssh "sudo bash /tmp/03_setup_remoto.sh base"
fi

cat <<EOF

VM pronta. Próximo passo: ./deploy/04_enviar_codigo.sh
Acesso manual: gcloud compute ssh $VM_NAME --project=$PROJECT_ID --zone=$ZONE --tunnel-through-iap
EOF
