#!/usr/bin/env bash
# 03 - Roda NA VM, como root (enviado pelo 02/04 via gcloud compute scp + ssh).
#   sudo bash 03_setup_remoto.sh base                 -> swap, Node 24, usuário, systemd, journald, vnstat
#   sudo bash 03_setup_remoto.sh app /tmp/app.tar.gz  -> instala/atualiza o código, npm ci, Chromium, timers
# Idempotente: pode ser executado várias vezes.
set -euo pipefail

# ---------------- Variáveis ----------------
APP_USER="${APP_USER:-alerta}"
BASE_DIR="${BASE_DIR:-/opt/alerta-alugueis}"         # home do usuário de serviço
APP_DIR="$BASE_DIR/app"
BROWSERS_DIR="$BASE_DIR/ms-playwright"
NODE_MAJOR="${NODE_MAJOR:-24}"
SWAP_GB="${SWAP_GB:-2}"
FUSO="${FUSO:-America/Sao_Paulo}"
MEMORY_MAX="${MEMORY_MAX:-850M}"                     # e2-micro tem 1 GB de RAM
MEMORY_SWAP_MAX="${MEMORY_SWAP_MAX:-1536M}"
SSJB_CALENDARIO="${SSJB_CALENDARIO:-*-*-* *:00,30:00}"   # a cada 30 min
DF_CALENDARIO="${DF_CALENDARIO:-*-*-* 00/6:10:00}"       # a cada 6 h
SEED="${SEED:-0}"                                    # 0 = não (o monitor já silencia a 1a coleta de cada site); 1 = força; auto = só se a VM não tiver estado
FORCAR_ESTADO="${FORCAR_ESTADO:-0}"                  # 1 = sobrescreve monitor/state da VM com o do pacote
# -------------------------------------------

log()  { printf '\033[1;34m[vm]\033[0m %s\n' "$*"; }
erro() { printf '\033[1;31m[vm] ERRO:\033[0m %s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || erro "Execute como root (sudo)."
export DEBIAN_FRONTEND=noninteractive

como_app() { # executa comando como o usuário de serviço, com o ambiente certo
  runuser -u "$APP_USER" -- env HOME="$BASE_DIR" PATH="/usr/local/bin:/usr/bin:/bin" \
    PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" TZ="$FUSO" "$@"
}

setup_swap() {
  if swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
    log "Swap já ativo."; return
  fi
  log "Criando swap de ${SWAP_GB} GB ..."
  [[ -f /swapfile ]] || { fallocate -l "${SWAP_GB}G" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_GB*1024)); }
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=30' > /etc/sysctl.d/90-alerta-swap.conf
  sysctl -q -p /etc/sysctl.d/90-alerta-swap.conf
}

setup_pacotes() {
  log "Instalando pacotes base (sem Ops Agent) ..."
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    ca-certificates curl xz-utils tar rsync jq vnstat unattended-upgrades util-linux >/dev/null
  systemctl enable --now vnstat >/dev/null 2>&1 || true
  timedatectl set-timezone "$FUSO" || true
}

setup_journald() {
  log "Limitando journald a 100 MB ..."
  mkdir -p /etc/systemd/journald.conf.d
  cat > /etc/systemd/journald.conf.d/90-alerta.conf <<'EOF'
[Journal]
SystemMaxUse=100M
SystemMaxFileSize=20M
MaxRetentionSec=1month
EOF
  systemctl restart systemd-journald
}

setup_node() {
  local arch atual versao arquivo url tmp
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) erro "Arquitetura não suportada: $(uname -m)" ;; esac
  atual="$(/usr/local/bin/node --version 2>/dev/null || true)"
  if [[ "$atual" == v${NODE_MAJOR}.* && "${NODE_ATUALIZAR:-0}" != "1" ]]; then
    log "Node $atual já instalado."; return
  fi
  tmp="$(mktemp -d)"
  url="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  curl -fsSL "$url/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  arquivo="$(awk -v a="linux-${arch}.tar.xz" '$2 ~ a"$" {print $2}' "$tmp/SHASUMS256.txt" | head -n1)"
  [[ -n "$arquivo" ]] || erro "Não achei o tarball do Node ${NODE_MAJOR} para linux-${arch}."
  versao="${arquivo%-linux-*}"   # node-v24.x.y
  log "Instalando $versao (tarball oficial nodejs.org, SHA-256 verificado) ..."
  curl -fsSL "$url/$arquivo" -o "$tmp/$arquivo"
  (cd "$tmp" && grep " $arquivo\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || erro "SHA-256 do Node não confere."
  rm -rf "/opt/$versao" "/opt/${arquivo%.tar.xz}"
  tar -xJf "$tmp/$arquivo" -C /opt
  mv "/opt/${arquivo%.tar.xz}" "/opt/$versao" 2>/dev/null || true
  ln -sfn "/opt/$versao" /opt/node
  for b in node npm npx corepack; do ln -sfn "/opt/node/bin/$b" "/usr/local/bin/$b"; done
  rm -rf "$tmp"
  log "Node: $(/usr/local/bin/node --version)"
}

setup_usuario() {
  if ! id "$APP_USER" >/dev/null 2>&1; then
    log "Criando usuário de serviço $APP_USER ..."
    useradd --system --user-group --home-dir "$BASE_DIR" --create-home --shell /usr/sbin/nologin "$APP_USER"
  fi
  mkdir -p "$APP_DIR" "$BROWSERS_DIR"
  chown -R "$APP_USER:$APP_USER" "$BASE_DIR"
  chmod 750 "$BASE_DIR"
}

setup_systemd() {
  log "Instalando units systemd (alerta@.service, alerta-ssjb.timer, alerta-df.timer) ..."
  cat > /etc/systemd/system/alerta@.service <<EOF
[Unit]
Description=Monitor de alugueis - grupo %i
After=network-online.target
Wants=network-online.target
ConditionPathExists=$APP_DIR/monitor/run.js
ConditionPathExists=$APP_DIR/.env

[Service]
Type=oneshot
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=HOME=$BASE_DIR
Environment=NODE_ENV=production
Environment=TZ=$FUSO
Environment=PLAYWRIGHT_BROWSERS_PATH=$BROWSERS_DIR
Environment=NODE_OPTIONS=--max-old-space-size=384
# flock: nunca roda dois grupos ao mesmo tempo (1 GB de RAM); espera até 40 min pelo outro.
ExecStart=/usr/bin/flock -w 2400 /run/lock/alerta-alugueis.lock /usr/local/bin/node monitor/run.js --grupo=%i
TimeoutStartSec=90min
MemoryMax=$MEMORY_MAX
MemorySwapMax=$MEMORY_SWAP_MAX
Nice=10
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
SyslogIdentifier=alerta-%i
EOF

  cat > /etc/systemd/system/alerta-ssjb.timer <<EOF
[Unit]
Description=Monitor de alugueis SSJB (a cada 30 min)

[Timer]
OnCalendar=$SSJB_CALENDARIO
RandomizedDelaySec=6min
AccuracySec=1min
Persistent=true
Unit=alerta@ssjb.service

[Install]
WantedBy=timers.target
EOF

  cat > /etc/systemd/system/alerta-df.timer <<EOF
[Unit]
Description=Monitor de alugueis DF (a cada 6 h)

[Timer]
OnCalendar=$DF_CALENDARIO
RandomizedDelaySec=20min
AccuracySec=1min
Persistent=true
Unit=alerta@df.service

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
}

base() {
  setup_swap
  setup_pacotes
  setup_journald
  setup_node
  setup_usuario
  setup_systemd
  log "Base pronta."
}

app() {
  local pacote="${1:-/tmp/alerta-app.tar.gz}" stage estado_vazio=0
  [[ -f "$pacote" ]] || erro "Pacote não encontrado: $pacote"
  [[ -x /usr/local/bin/node && -f /etc/systemd/system/alerta@.service ]] || base

  log "Parando timers durante a atualização ..."
  systemctl stop alerta-ssjb.timer alerta-df.timer 2>/dev/null || true
  # espera execução em andamento terminar (no máx. 30 min)
  for _ in $(seq 1 180); do
    systemctl is-active --quiet alerta@ssjb.service || systemctl is-active --quiet alerta@df.service || break
    sleep 10
  done

  stage="$(mktemp -d)"
  tar -xzf "$pacote" -C "$stage"
  [[ -f "$stage/package.json" ]] || erro "Pacote inválido (sem package.json)."

  if [[ -z "$(ls -A "$APP_DIR/monitor/state" 2>/dev/null)" ]]; then estado_vazio=1; fi

  log "Sincronizando código em $APP_DIR (preservando node_modules e monitor/state) ..."
  rsync -a --delete --exclude='/node_modules/' --exclude='/monitor/state/' "$stage/" "$APP_DIR/"
  mkdir -p "$APP_DIR/monitor/state"
  if [[ -d "$stage/monitor/state" ]] && { [[ "$estado_vazio" -eq 1 ]] || [[ "$FORCAR_ESTADO" == "1" ]]; }; then
    log "Copiando monitor/state do pacote (primeiro deploy ou FORCAR_ESTADO=1) ..."
    rsync -a "$stage/monitor/state/" "$APP_DIR/monitor/state/"
  fi
  rm -rf "$stage" "$pacote"
  chown -R "$APP_USER:$APP_USER" "$BASE_DIR"
  [[ -f "$APP_DIR/.env" ]] && chmod 600 "$APP_DIR/.env"

  log "npm ci --omit=dev ..."
  (cd "$APP_DIR" && como_app npm ci --omit=dev --no-audit --no-fund --loglevel=error)

  log "Dependências de sistema do Chromium (playwright install-deps) ..."
  (cd "$APP_DIR" && PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" ./node_modules/.bin/playwright install-deps chromium >/dev/null)
  log "Baixando Chromium do Playwright (versão casada com o package-lock) ..."
  (cd "$APP_DIR" && como_app ./node_modules/.bin/playwright install chromium)

  # Seed: popula o estado sem mandar alertas antigos no Telegram
  #   auto: só quando a VM não tinha estado E o pacote não trouxe histórico de execuções.
  if [[ "$SEED" == "1" ]] || { [[ "$SEED" == "auto" ]] && [[ "$estado_vazio" -eq 1 ]] && [[ ! -f "$APP_DIR/monitor/state/execucoes.jsonl" ]]; }; then
    for g in ssjb df; do
      log "Rodando seed do grupo $g (pode levar vários minutos) ..."
      (cd "$APP_DIR" && como_app /usr/bin/flock /run/lock/alerta-alugueis.lock \
        /usr/local/bin/node monitor/run.js --grupo="$g" --seed) || log "Seed de $g falhou (veja a saída acima); os timers seguem normalmente."
    done
  fi

  log "Habilitando timers ..."
  systemctl daemon-reload
  systemctl enable --now alerta-ssjb.timer alerta-df.timer >/dev/null
  systemctl list-timers 'alerta-*' --no-pager
  log "Deploy concluído."
}

case "${1:-base}" in
  base) base ;;
  app)  shift; app "$@" ;;
  *)    erro "Uso: $0 base | app <pacote.tar.gz>" ;;
esac
