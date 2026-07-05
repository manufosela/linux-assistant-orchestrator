#!/bin/bash
# Lado servidorix (siempre encendido): reenvía a Telegram, vía el webhook local
# de LUIS, los reports que move-tg-to-nas (portátil) deja en
# "$BASE_DIR/.move-reports/". Cada report es un .txt con el mensaje ya formateado.
#
# El portátil es efímero y no habla con LUIS ni maneja tokens: sólo suelta el
# fichero en el NAS. Este script, en servidorix, es quien envía el aviso. Un
# report se borra sólo si el POST tuvo éxito; si LUIS está caído, se reintenta en
# la siguiente pasada.
#
# Cron sugerido (servidorix):
#   */5 * * * * BASE_DIR=/media/raid5 /media/raid5/SRC/notify-move-reports.sh >/dev/null 2>&1
set -u

BASE_DIR="${BASE_DIR:-/media/raid5}"
REPORT_DIR="$BASE_DIR/.move-reports"
LUIS_URL="${WATCHTOWER_URL:-http://localhost:3030/api/hooks/watchtower}"
ENV_FILE="${WATCHTOWER_ENV_FILE:-$HOME/luis/.env}"

[[ -d "$REPORT_DIR" ]] || exit 0
command -v jq   >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

TOKEN="${WATCHTOWER_WEBHOOK_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$ENV_FILE" ]]; then
    TOKEN=$(grep '^WATCHTOWER_WEBHOOK_TOKEN=' "$ENV_FILE" 2>/dev/null | sed 's/^WATCHTOWER_WEBHOOK_TOKEN=//')
fi
[[ -z "$TOKEN" ]] && exit 0

shopt -s nullglob
for f in "$REPORT_DIR"/*.txt; do
    [[ -f "$f" ]] || continue
    msg=$(cat "$f")
    if [[ -z "$msg" ]]; then
        rm -f "$f"
        continue
    fi
    payload=$(jq -n --arg m "$msg" '{message: $m}')
    if curl -fsS --max-time 10 -X POST "${LUIS_URL}?token=${TOKEN}" \
         -H 'Content-Type: application/json' \
         -d "$payload" >/dev/null 2>&1; then
        rm -f "$f"
    fi
done
