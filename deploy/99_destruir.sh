#!/usr/bin/env bash
# 99 - Apaga a VM, a rede criada e (opcionalmente) o projeto inteiro e o orçamento.
# Uso:  ./deploy/99_destruir.sh
#       APAGAR_PROJETO=1 ./deploy/99_destruir.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_comum.sh"
carregar_estado

# ---------------- Variáveis ----------------
PROJECT_ID="${PROJECT_ID:-}"
ZONE="${ZONE:-us-central1-a}"
REGION="${REGION:-${ZONE%-*}}"
VM_NAME="${VM_NAME:-alerta-alugueis}"
REDE="${REDE:-alerta-vpc}"
SUBREDE="${SUBREDE:-alerta-subnet}"
APAGAR_PROJETO="${APAGAR_PROJETO:-0}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"
BUDGET_NOME="${BUDGET_NOME:-alerta-alugueis-${PROJECT_ID}}"
# -------------------------------------------

checar_gcloud
exigir_projeto
G=(--project="$PROJECT_ID")

aviso "Isto APAGA a VM '$VM_NAME' (e o disco, com o estado do monitor) no projeto '$PROJECT_ID'."
read -r -p "Digite o nome da VM para confirmar: " RESP
[[ "$RESP" == "$VM_NAME" ]] || erro "Confirmação não confere. Nada foi apagado."

if gcloud compute instances describe "$VM_NAME" "${G[@]}" --zone="$ZONE" >/dev/null 2>&1; then
  if confirmar "Baixar uma cópia de monitor/state antes de apagar?"; then
    DEST="$RAIZ_PROJETO/monitor/state-backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$DEST"
    if vm_ssh "sudo tar -czf /tmp/state.tgz -C /opt/alerta-alugueis/app/monitor state && sudo chmod 644 /tmp/state.tgz" \
      && gcloud compute scp "${G[@]}" --zone="$ZONE" --tunnel-through-iap --quiet "$VM_NAME:/tmp/state.tgz" "$DEST/"; then
      ok "Backup em $DEST/state.tgz"
    else
      aviso "Backup falhou; seguindo."
    fi
  fi
  msg "Apagando VM $VM_NAME (com discos) ..."
  gcloud compute instances delete "$VM_NAME" "${G[@]}" --zone="$ZONE" --delete-disks=all --quiet
else
  ok "VM $VM_NAME não existe."
fi

msg "Apagando firewall, sub-rede e rede (se existirem) ..."
gcloud compute firewall-rules delete "${REDE}-allow-iap-ssh" "${G[@]}" --quiet 2>/dev/null || true
gcloud compute networks subnets delete "$SUBREDE" "${G[@]}" --region="$REGION" --quiet 2>/dev/null || true
gcloud compute networks delete "$REDE" "${G[@]}" --quiet 2>/dev/null || true

if [[ -n "$BILLING_ACCOUNT" ]] && confirmar "Apagar também o orçamento '$BUDGET_NOME'?"; then
  B="$(gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" --billing-project="$PROJECT_ID" \
        --filter="displayName=\"$BUDGET_NOME\"" --format='value(name)' 2>/dev/null || true)"
  [[ -z "$B" ]] || gcloud billing budgets delete "$B" --billing-project="$PROJECT_ID" --quiet
fi

if [[ "$APAGAR_PROJETO" == "1" ]]; then
  aviso "APAGAR_PROJETO=1: o projeto '$PROJECT_ID' inteiro será marcado para exclusão (30 dias para recuperar)."
  read -r -p "Digite o ID do projeto para confirmar: " RESP
  if [[ "$RESP" == "$PROJECT_ID" ]]; then
    gcloud projects delete "$PROJECT_ID" --quiet
    rm -f "$ARQ_ESTADO"
    ok "Projeto apagado."
  else
    aviso "Confirmação não confere; projeto mantido."
  fi
fi
ok "Concluído."
