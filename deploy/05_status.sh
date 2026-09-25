#!/usr/bin/env bash
# 05 - Status: timers, últimas execuções, memória, disco, tráfego do mês (vnstat) e checagens de custo.
# Uso:  ./deploy/05_status.sh [N_LINHAS]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_comum.sh"
carregar_estado

# ---------------- Variáveis ----------------
PROJECT_ID="${PROJECT_ID:-}"
ZONE="${ZONE:-us-central1-a}"
VM_NAME="${VM_NAME:-alerta-alugueis}"
N="${1:-10}"
APP_DIR="/opt/alerta-alugueis/app"
# -------------------------------------------

checar_gcloud
exigir_projeto
G=(--project="$PROJECT_ID")

msg "VM"
gcloud compute instances describe "$VM_NAME" "${G[@]}" --zone="$ZONE" \
  --format='table(name,status,machineType.basename(),networkInterfaces[0].accessConfigs[0].natIP:label=IPV4_EXTERNO,networkInterfaces[0].accessConfigs[0].networkTier:label=TIER,networkInterfaces[0].ipv6AccessConfigs[0].externalIpv6:label=IPV6)'

msg "Checagens de custo (tudo abaixo deveria estar vazio / só o disco da VM)"
echo "- Discos:";            gcloud compute disks list "${G[@]}" --format='table(name,zone.basename(),sizeGb,type.basename())'
echo "- Snapshots:";         gcloud compute snapshots list "${G[@]}" --format='value(name)' | sed 's/^/    /'
echo "- Políticas snapshot:"; gcloud compute resource-policies list "${G[@]}" --format='value(name)' | sed 's/^/    /'
echo "- IPs reservados:";    gcloud compute addresses list "${G[@]}" --format='value(name,status)' | sed 's/^/    /'
echo "- Imagens próprias:";  gcloud compute images list "${G[@]}" --no-standard-images --format='value(name)' | sed 's/^/    /'

msg "Dentro da VM"
vm_ssh "bash -s" <<EOF
set -u
echo '--- Timers ---'
systemctl list-timers 'alerta-*' --all --no-pager
echo; echo '--- Última execução de cada grupo ---'
for g in ssjb df; do
  systemctl show "alerta@\$g.service" -p Result -p ExecMainStatus -p ExecMainExitTimestamp --no-pager | tr '\n' ' '; echo " [\$g]"
done
echo; echo '--- monitor/state/execucoes.jsonl (últimas $N) ---'
if sudo test -f $APP_DIR/monitor/state/execucoes.jsonl; then
  if command -v jq >/dev/null; then
    sudo tail -n $N $APP_DIR/monitor/state/execucoes.jsonl | jq -c . 2>/dev/null || sudo tail -n $N $APP_DIR/monitor/state/execucoes.jsonl
  else
    sudo tail -n $N $APP_DIR/monitor/state/execucoes.jsonl
  fi
else
  echo '(ainda não existe)'
fi
echo; echo '--- Log recente (journald) ---'
sudo journalctl -u 'alerta@*' -n $N --no-pager -o short-iso
echo; echo '--- Memória / swap / disco ---'
free -h; swapon --show; df -h / | tail -n1
echo; echo "--- Journald ocupa: \$(sudo journalctl --disk-usage 2>/dev/null | grep -o '[0-9.]*[KMG]' | head -n1)"
echo; echo '--- Tráfego de rede no mês (vnstat; tx = saída cobrável) ---'
vnstat -m 2>/dev/null | tail -n 6 || echo 'vnstat ainda coletando (aguarde alguns minutos após o setup)'
EOF

cat <<EOF

Referência de custo: saída (tx) grátis até 200 GiB/mês na camada Standard (modo ipv4)
ou 1 GB/mês na Premium (modo ipv6). Custos reais: https://console.cloud.google.com/billing/reports?project=$PROJECT_ID
EOF
