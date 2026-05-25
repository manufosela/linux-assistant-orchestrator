#!/bin/bash
# Wrapper de organize_nightly.py:
#  - Inyecta BASE_DIR.
#  - Ejecuta el script.
#  - Notifica resultado a Telegram vía webhook de LUIS (/api/hooks/watchtower):
#      * fallo (exit≠0 o ERROR en log) → mensaje de error con resumen
#      * nada procesado          → silencio
#      * algo procesado          → mensaje con desglose por categoría (RESUMEN del log)
#
# Para cron: 0 2 * * * /media/raid5/SRC/organize_nightly_wrapped.sh >/dev/null 2>&1

set -u

SCRIPT=/media/raid5/SRC/organize_nightly.py
LOG=/media/raid5/organize_nightly.log
WATCHED_DIR=/media/raid5/TelegramDownloads
ENV_FILE=/home/manu/luis/.env
LUIS_URL=http://localhost:3030/api/hooks/watchtower

TOKEN=$(grep '^WATCHTOWER_WEBHOOK_TOKEN=' "$ENV_FILE" 2>/dev/null | sed 's/^WATCHTOWER_WEBHOOK_TOKEN=//')

notify() {
  local msg="$1"
  if [ -z "$TOKEN" ]; then return 0; fi
  local payload
  payload=$(jq -n --arg m "$msg" '{message: $m}')
  curl -fsS --max-time 10 -X POST "${LUIS_URL}?token=${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "$payload" > /dev/null 2>&1 || true
}

BEFORE_COUNT=$(ls "$WATCHED_DIR" 2>/dev/null | wc -l)

BASE_DIR=/media/raid5 python3 "$SCRIPT"
EXIT=$?

AFTER_COUNT=$(ls "$WATCHED_DIR" 2>/dev/null | wc -l)
PROCESSED=$((BEFORE_COUNT - AFTER_COUNT))
ERRORS=$(grep -cE '^ERROR|: ERROR' "$LOG" 2>/dev/null || echo 0)

if [ "$EXIT" -ne 0 ] || [ "$ERRORS" -gt 0 ]; then
  TAIL=$(grep -E '^ERROR|: ERROR' "$LOG" 2>/dev/null | tail -5)
  [ -z "$TAIL" ] && TAIL=$(tail -8 "$LOG" 2>/dev/null)
  notify "❌ organize_nightly falló (exit=${EXIT}, errores=${ERRORS}).
Pendientes: ${AFTER_COUNT} ficheros.
Últimos errores:
${TAIL}"
elif [ "$PROCESSED" -le 0 ]; then
  : # nada que reportar
else
  RESUMEN_RAW=$(grep 'RESUMEN:' "$LOG" 2>/dev/null | tail -1 | sed 's/^.*RESUMEN: //')
  DESGLOSE=$(echo "$RESUMEN_RAW" | tr ',' '\n' | sed -e 's/^ *//' \
    -e 's/^peliculas=/🎬 películas: /' \
    -e 's/^series=/📺 series: /' \
    -e 's/^anime=/🎌 anime: /' \
    -e 's/^libros=/📚 libros: /' \
    -e 's/^audiolibros=/🎧 audiolibros: /' \
    -e 's/^comics=/📖 comics: /' \
    -e 's/^sin_clasificar=/❓ sin clasificar (se quedan): /' \
    -e 's/^pendientes_api=/⏳ pendientes API: /' \
    -e 's/^sin_clasificacion_ai=/🤖 sin clasif AI: /')
  notify "✅ organize_nightly OK — ${PROCESSED} ficheros procesados (${BEFORE_COUNT} → ${AFTER_COUNT}).
${DESGLOSE}"
fi

exit "$EXIT"
