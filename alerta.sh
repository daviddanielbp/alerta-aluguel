#!/usr/bin/env bash
# Controle do alerta de aluguel.
#
#   ./alerta.sh local    roda no seu Mac a cada 30 min (Ctrl+C para parar)
#   ./alerta.sh nuvem    liga os robôs do GitHub (rodam sem o seu PC)
#   ./alerta.sh pausar   pausa os robôs do GitHub
#   ./alerta.sh status   mostra se a nuvem está ligada, minutos usados e últimas rodadas
#
# Mac e nuvem usam o MESMO histórico de anúncios (monitor/state no GitHub): antes de cada
# rodada local o estado é baixado e depois enviado de volta, então nada chega repetido.
set -euo pipefail
cd "$(dirname "$0")"

CONTA="daviddanielbp"
REPO="daviddanielbp/alerta-aluguel-unb"
INTERVALO_MIN="${INTERVALO_MIN:-30}"     # rodada local de SS/JB
DF_A_CADA_H="${DF_A_CADA_H:-6}"          # rodada local do DF inteiro
WORKFLOWS=(monitor-ssjb.yml monitor-df.yml)

GH_TOKEN="$(gh auth token -u "$CONTA" 2>/dev/null)" || { echo "❌ gh sem login na conta $CONTA (rode: gh auth login)"; exit 1; }
export GH_TOKEN
gh_repo() { gh "$@" --repo "$REPO"; }

sincronizar_baixar() { git pull --rebase --autostash -q -X theirs origin main || echo "⚠️  não consegui baixar o estado (sem internet?) — sigo com o local"; }
sincronizar_enviar() {
  git add monitor/state/vistos.json monitor/state/geocache.json monitor/state/execucoes.jsonl 2>/dev/null || true
  git diff --cached --quiet && return 0
  git commit -q -m "estado: local $(date +'%d/%m %H:%M')"
  for _ in 1 2 3; do git pull --rebase -q -X theirs origin main && git push -q origin main && return 0; sleep 5; done
  echo "⚠️  não consegui enviar o estado agora — vai na próxima rodada"
}
nuvem_rodando() { [ -n "$(gh_repo run list --status in_progress --json databaseId --jq '.[].databaseId' 2>/dev/null)" ]; }

rodada() {
  local grupo="$1"; shift
  if nuvem_rodando; then echo "☁️  a nuvem está rodando agora — pulo esta rodada local para não duplicar"; return 0; fi
  sincronizar_baixar
  env "$@" node monitor/run.js --grupo="$grupo" || echo "⚠️  rodada $grupo terminou com erro"
  sincronizar_enviar
}

case "${1:-}" in
  local)
    echo "🏠 Modo LOCAL: SS/JB a cada ${INTERVALO_MIN} min, DF inteiro a cada ${DF_A_CADA_H} h. Ctrl+C para parar."
    echo "   (a nuvem continua ligada como reserva; se o PC desligar, ela segue sozinha)"
    ultimo_df=0
    while true; do
      agora=$(date +%s)
      if (( agora - ultimo_df >= DF_A_CADA_H * 3600 )); then
        echo "── $(date +'%H:%M') DF inteiro + varredura ampla de SS/JB"
        rodada todos SSJB_AMPLO=1; ultimo_df=$agora
      else
        echo "── $(date +'%H:%M') São Sebastião + Jardim Botânico"
        rodada ssjb
      fi
      echo "   próxima rodada às $(date -v+"${INTERVALO_MIN}"M +'%H:%M')"
      sleep $(( INTERVALO_MIN * 60 ))
    done
    ;;
  nuvem)
    for w in "${WORKFLOWS[@]}"; do gh_repo workflow enable "$w"; done
    echo "☁️  Modo NUVEM ligado: SS/JB a cada 2 h e DF inteiro 1x/dia, sem precisar do seu PC."
    ;;
  pausar)
    for w in "${WORKFLOWS[@]}"; do gh_repo workflow disable "$w"; done
    echo "⏸️  Robôs da nuvem pausados. Para religar: ./alerta.sh nuvem"
    ;;
  status)
    gh_repo workflow list --all
    git pull -q --rebase --autostash origin main 2>/dev/null || true
    node monitor/orcamento.js status
    echo "Últimas rodadas na nuvem:"; gh_repo run list --limit 5
    ;;
  *)
    sed -n '4,8p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
