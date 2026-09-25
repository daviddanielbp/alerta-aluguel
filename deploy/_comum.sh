# shellcheck shell=bash
# Funções compartilhadas pelos scripts de deploy (não execute diretamente).
# Compatível com o bash 3.2 do macOS.

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034  # usado pelos scripts que fazem source
RAIZ_PROJETO="$(cd "$DEPLOY_DIR/.." && pwd)"
ARQ_ESTADO="$DEPLOY_DIR/.deploy.env"   # gerado pelo 01_projeto.sh (PROJECT_ID etc.)

msg()   { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m OK\033[0m %s\n' "$*"; }
aviso() { printf '\033[1;33mAVISO:\033[0m %s\n' "$*" >&2; }
erro()  { printf '\033[1;31mERRO:\033[0m %s\n' "$*" >&2; exit 1; }

# Carrega deploy/.deploy.env sem sobrescrever variáveis já definidas no ambiente.
carregar_estado() {
  [[ -f "$ARQ_ESTADO" ]] || return 0
  local linha chave valor
  while IFS= read -r linha || [[ -n "$linha" ]]; do
    [[ "$linha" =~ ^[A-Z_][A-Z0-9_]*= ]] || continue
    chave="${linha%%=*}"
    valor="${linha#*=}"
    valor="${valor%\"}"; valor="${valor#\"}"
    if [[ -z "${!chave:-}" ]]; then
      export "$chave=$valor"
    fi
  done < "$ARQ_ESTADO"
}

salvar_estado() { # uso: salvar_estado CHAVE VALOR
  local chave="$1" valor="$2" tmp
  tmp="$(mktemp)"
  if [[ -f "$ARQ_ESTADO" ]]; then
    grep -v "^${chave}=" "$ARQ_ESTADO" > "$tmp" || true
  fi
  printf '%s="%s"\n' "$chave" "$valor" >> "$tmp"
  mv "$tmp" "$ARQ_ESTADO"
}

checar_gcloud() {
  command -v gcloud >/dev/null 2>&1 || erro "gcloud não encontrado. Instale: https://cloud.google.com/sdk/docs/install"
  if ! gcloud auth print-access-token >/dev/null 2>&1; then
    erro "Credenciais do gcloud expiradas/ausentes. Rode: gcloud auth login"
  fi
}

exigir_projeto() {
  [[ -n "${PROJECT_ID:-}" ]] || erro "PROJECT_ID não definido. Rode antes o 01_projeto.sh ou exporte PROJECT_ID=..."
}

# SSH via IAP (a VM não aceita SSH direto da internet).
vm_ssh() { # uso: vm_ssh "comando" [args extras do gcloud]
  local cmd="$1"; shift
  gcloud compute ssh "$VM_NAME" --project="$PROJECT_ID" --zone="$ZONE" \
    --tunnel-through-iap --quiet --command="$cmd" "$@"
}

vm_scp() { # uso: vm_scp origem... destino_remoto
  local args=() ultimo
  ultimo="${*: -1}"
  args=("${@:1:$#-1}")
  gcloud compute scp --project="$PROJECT_ID" --zone="$ZONE" \
    --tunnel-through-iap --quiet "${args[@]}" "$VM_NAME:$ultimo"
}

confirmar() { # uso: confirmar "pergunta" -> retorna 0 se s/S
  local resp
  read -r -p "$1 [s/N] " resp
  [[ "$resp" == "s" || "$resp" == "S" ]]
}
