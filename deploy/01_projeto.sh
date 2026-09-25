#!/usr/bin/env bash
# 01 - Cria o projeto GCP, liga ao faturamento, habilita APIs e cria o alerta de orçamento.
# Uso:  ./deploy/01_projeto.sh
#       PROJECT_ID=meu-id BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX ./deploy/01_projeto.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_comum.sh"
carregar_estado

# ---------------- Variáveis (podem vir do ambiente) ----------------
PROJECT_ID="${PROJECT_ID:-alerta-alugueis-$(openssl rand -hex 3)}"
PROJECT_NOME="${PROJECT_NOME:-Alerta Alugueis}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"   # vazio = detecta a única conta de faturamento aberta
BUDGET_NOME="${BUDGET_NOME:-alerta-alugueis-${PROJECT_ID}}"
BUDGET_VALOR="${BUDGET_VALOR:-}"         # vazio = 5 (BRL) ou 1 (USD), conforme a moeda da conta
BUDGET_MOEDA="${BUDGET_MOEDA:-}"         # vazio = detecta pela conta de faturamento
APIS="compute.googleapis.com iap.googleapis.com billingbudgets.googleapis.com cloudbilling.googleapis.com"
# -------------------------------------------------------------------

checar_gcloud
[[ "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || erro "PROJECT_ID inválido: $PROJECT_ID (6-30 caracteres, minúsculas/dígitos/hífen)"

# 1) Projeto
if gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  ok "Projeto $PROJECT_ID já existe (reaproveitando)."
else
  msg "Criando projeto $PROJECT_ID ..."
  gcloud projects create "$PROJECT_ID" --name="$PROJECT_NOME" --labels=app=alerta-alugueis
fi
salvar_estado PROJECT_ID "$PROJECT_ID"

# 2) Conta de faturamento
if [[ -z "$BILLING_ACCOUNT" ]]; then
  msg "Procurando contas de faturamento abertas ..."
  CONTAS="$(gcloud billing accounts list --filter='open=true' --format='value(name.basename())')"
  QTD="$(printf '%s\n' "$CONTAS" | grep -c . || true)"
  if [[ "$QTD" -eq 0 ]]; then
    erro "Nenhuma conta de faturamento aberta. Cadastre um cartão em https://console.cloud.google.com/billing e rode de novo."
  elif [[ "$QTD" -gt 1 ]]; then
    gcloud billing accounts list --filter='open=true'
    erro "Há $QTD contas abertas. Escolha uma: BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX $0"
  fi
  BILLING_ACCOUNT="$CONTAS"
fi
BILLING_ACCOUNT="${BILLING_ACCOUNT#billingAccounts/}"
salvar_estado BILLING_ACCOUNT "$BILLING_ACCOUNT"
ok "Conta de faturamento: ${BILLING_ACCOUNT:0:6}-…"

ATUAL="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)' 2>/dev/null || true)"
if [[ "$ATUAL" == "billingAccounts/$BILLING_ACCOUNT" ]]; then
  ok "Projeto já vinculado ao faturamento."
else
  msg "Vinculando projeto ao faturamento ..."
  gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
fi

# 3) APIs
msg "Habilitando APIs: $APIS"
# shellcheck disable=SC2086
gcloud services enable $APIS --project="$PROJECT_ID"

# 4) Orçamento (budget) com alertas por e-mail aos administradores da conta de faturamento
if [[ -z "$BUDGET_MOEDA" ]]; then
  BUDGET_MOEDA="$(gcloud billing accounts describe "$BILLING_ACCOUNT" --format='value(currencyCode)' 2>/dev/null || true)"
fi
[[ -n "$BUDGET_MOEDA" ]] || erro "Não consegui detectar a moeda da conta. Rode com BUDGET_MOEDA=BRL (ou USD)."
if [[ -z "$BUDGET_VALOR" ]]; then
  case "$BUDGET_MOEDA" in
    BRL) BUDGET_VALOR="5" ;;
    USD) BUDGET_VALOR="1" ;;
    *)   erro "Moeda $BUDGET_MOEDA: defina BUDGET_VALOR explicitamente." ;;
  esac
fi
ok "Moeda da conta: $BUDGET_MOEDA — orçamento: $BUDGET_VALOR $BUDGET_MOEDA/mês"

EXISTE="$(gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" \
  --billing-project="$PROJECT_ID" \
  --filter="displayName=\"$BUDGET_NOME\"" --format='value(name)' 2>/dev/null || true)"
if [[ -n "$EXISTE" ]]; then
  ok "Orçamento '$BUDGET_NOME' já existe (não alterado). Para mudar o valor, edite no console ou apague e rode de novo."
else
  msg "Criando orçamento '$BUDGET_NOME' ($BUDGET_VALOR $BUDGET_MOEDA, alertas 50/90/100% + previsão 100%) ..."
  gcloud billing budgets create \
    --billing-account="$BILLING_ACCOUNT" \
    --billing-project="$PROJECT_ID" \
    --display-name="$BUDGET_NOME" \
    --budget-amount="${BUDGET_VALOR}${BUDGET_MOEDA}" \
    --calendar-period=month \
    --filter-projects="projects/$PROJECT_ID" \
    --threshold-rule=percent=0.50 \
    --threshold-rule=percent=0.90 \
    --threshold-rule=percent=1.00 \
    --threshold-rule=percent=1.00,basis=forecasted-spend
fi

cat <<EOF

Pronto. Projeto: $PROJECT_ID (salvo em deploy/.deploy.env)
Lembrete: orçamento só AVISA por e-mail; ele NÃO desliga nada automaticamente.
Próximo passo: ./deploy/02_vm.sh
EOF
