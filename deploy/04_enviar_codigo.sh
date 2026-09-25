#!/usr/bin/env bash
# 04 - Empacota o projeto e publica na VM (npm ci, Chromium, timers). Idempotente: use para todo re-deploy.
# Uso:  ./deploy/04_enviar_codigo.sh
#       SEED=1 ./deploy/04_enviar_codigo.sh           (força --seed nos dois grupos; normalmente desnecessário)
#       FORCAR_ESTADO=1 ./deploy/04_enviar_codigo.sh  (sobrescreve monitor/state da VM com o local)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_comum.sh"
carregar_estado

# ---------------- Variáveis ----------------
PROJECT_ID="${PROJECT_ID:-}"
ZONE="${ZONE:-us-central1-a}"
VM_NAME="${VM_NAME:-alerta-alugueis}"
SEED="${SEED:-0}"   # o monitor já faz seed sozinho na 1a coleta de cada site; 1 = força --seed
FORCAR_ESTADO="${FORCAR_ESTADO:-0}"
PACOTE_REMOTO="/tmp/alerta-app.tar.gz"
# -------------------------------------------

checar_gcloud
exigir_projeto
cd "$RAIZ_PROJETO"
[[ -f package.json && -f package-lock.json ]] || erro "package.json/package-lock.json ausentes em $RAIZ_PROJETO."
[[ -f monitor/run.js ]] || erro "monitor/run.js não existe ainda."
[[ -f .env ]] || erro ".env não existe na raiz (precisa de TELEGRAM_TOKEN etc.)."
grep -q '^TELEGRAM_TOKEN=.\+' .env || aviso ".env sem TELEGRAM_TOKEN preenchido."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PACOTE="$TMP/alerta-app.tar.gz"

msg "Empacotando projeto (sem node_modules, data/, .git, deploy/, relatórios) ..."
# COPYFILE_DISABLE evita arquivos ._* do macOS no tar.
COPYFILE_DISABLE=1 tar -czf "$PACOTE" \
  --exclude='./node_modules' --exclude='*/node_modules' \
  --exclude='./data' --exclude='./data_ss' \
  --exclude='./.git' --exclude='./deploy' \
  --exclude='.DS_Store' --exclude='*.pdf' --exclude='*.xlsx' \
  --exclude='./monitor/state/run.lock' --exclude='./monitor/state/work' --exclude='./monitor/state/logs' \
  --exclude='./monitor/_runs' --exclude='./monitor/_backup_*' \
  -C "$RAIZ_PROJETO" .
ok "Pacote: $(du -h "$PACOTE" | cut -f1)"

msg "Enviando para $VM_NAME ($ZONE) via IAP ..."
vm_scp "$PACOTE" "$DEPLOY_DIR/03_setup_remoto.sh" "/tmp/"

msg "Instalando na VM ..."
vm_ssh "sudo SEED='$SEED' FORCAR_ESTADO='$FORCAR_ESTADO' bash /tmp/03_setup_remoto.sh app '$PACOTE_REMOTO'"

ok "Deploy feito. Acompanhe com ./deploy/05_status.sh"
