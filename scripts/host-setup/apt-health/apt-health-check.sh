#!/bin/bash
# apt-health-check.sh — Detecta condiciones que merecen aviso por Telegram
# vía el webhook /api/hooks/apt-health de LUIS:
#
#   upgrade-failed   unattended-upgrades terminó con error o el log tiene
#                    ERROR desde ayer.
#   pending-old      ≥ MIN_PENDING paquetes pendientes desde hace
#                    > PENDING_DAYS días.
#   reboot-pending   /var/run/reboot-required con mtime > REBOOT_DAYS días.
#
# Config (variables de entorno, leídas desde /etc/apt-health-check.env):
#   APT_HEALTH_WEBHOOK_URL    URL completa al endpoint (ej. http://servidorix:3030/api/hooks/apt-health)
#   APT_HEALTH_WEBHOOK_TOKEN  Bearer token compartido con LUIS
#   APT_HEALTH_HOST           Hostname a reportar (default: $(hostname))
#   MIN_PENDING               Default 5
#   PENDING_DAYS              Default 5
#   REBOOT_DAYS               Default 7
#
# Modos:
#   apt-health-check.sh                         → chequeo periódico (3 eventos)
#   apt-health-check.sh --event=upgrade-failed  → fuerza un evento concreto
#                                                  (usado por OnFailure del
#                                                  servicio apt-daily-upgrade)
#
# Sale 0 siempre. Loguea por stdout/stderr → journald.

set -u

CONFIG_FILE="${APT_HEALTH_CONFIG:-/etc/apt-health-check.env}"
[[ -r "$CONFIG_FILE" ]] && . "$CONFIG_FILE"

: "${APT_HEALTH_WEBHOOK_URL:=}"
: "${APT_HEALTH_WEBHOOK_TOKEN:=}"
: "${APT_HEALTH_HOST:=$(hostname)}"
: "${MIN_PENDING:=5}"
: "${PENDING_DAYS:=5}"
: "${REBOOT_DAYS:=7}"

STATE_DIR="/var/lib/apt-health-check"
PENDING_STATE="$STATE_DIR/pending-first-seen"
mkdir -p "$STATE_DIR"

if [[ -z "$APT_HEALTH_WEBHOOK_URL" || -z "$APT_HEALTH_WEBHOOK_TOKEN" ]]; then
  echo "apt-health-check: APT_HEALTH_WEBHOOK_URL or APT_HEALTH_WEBHOOK_TOKEN unset; nothing to do" >&2
  exit 0
fi

TODAY="$(date -u +%Y-%m-%d)"

# Envía un evento al webhook. POST JSON con Bearer token. No falla el script
# si LUIS está caído: solo loguea y continúa.
send_event() {
  local event="$1"
  local detail="$2"
  local extra="$3"  # JSON extra fields, e.g. '"count":7,"days":5'
  local payload
  if [[ -n "$extra" ]]; then
    payload=$(printf '{"host":%s,"event":%s,"detail":%s,"day":%s,%s}' \
      "$(json_str "$APT_HEALTH_HOST")" \
      "$(json_str "$event")" \
      "$(json_str "$detail")" \
      "$(json_str "$TODAY")" \
      "$extra")
  else
    payload=$(printf '{"host":%s,"event":%s,"detail":%s,"day":%s}' \
      "$(json_str "$APT_HEALTH_HOST")" \
      "$(json_str "$event")" \
      "$(json_str "$detail")" \
      "$(json_str "$TODAY")")
  fi

  local response
  response=$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 10 \
    -H "Authorization: Bearer ${APT_HEALTH_WEBHOOK_TOKEN}" \
    -H 'Content-Type: application/json' \
    -X POST "$APT_HEALTH_WEBHOOK_URL" \
    --data "$payload" 2>&1) || true
  echo "apt-health-check: event=$event http=$response"
}

# Escapa un string para JSON (solo " y \, suficiente aquí).
json_str() {
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/}"
  s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

# Modo "forzar un evento". Usado por el drop-in OnFailure.
if [[ "${1:-}" =~ ^--event= ]]; then
  forced_event="${1#--event=}"
  log_tail="$(tail -n 30 /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null | grep -E 'ERROR|installArchives|dpkg' | tail -n 5)"
  send_event "$forced_event" "$log_tail" ""
  exit 0
fi

# ── Chequeos periódicos ────────────────────────────────────────────────────

# 1) upgrade-failed: busca ERROR en el log de unattended-upgrades desde ayer.
yesterday="$(date -u -d 'yesterday' +%Y-%m-%d)"
recent_errors="$(awk -v since="$yesterday" '
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}/ { if ($1 >= since) recent=1; else recent=0 }
  recent && /ERROR/ { print }
' /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null | tail -n 5)"

if [[ -n "$recent_errors" ]]; then
  send_event "upgrade-failed" "$recent_errors" ""
fi

# 2) pending-old: ≥ MIN_PENDING paquetes pendientes desde > PENDING_DAYS días.
#
# Algoritmo:
#   - `apt list --upgradable` da el set actual de paquetes pendientes.
#   - Registramos por paquete cuándo se vio por primera vez en
#     $PENDING_STATE (formato: "pkg<TAB>first-seen-epoch").
#   - Limpiamos los que ya no están pendientes.
#   - Disparamos si ≥ MIN_PENDING paquetes llevan > PENDING_DAYS días.
declare -A CURRENT_PENDING=()
while IFS= read -r pkg; do
  [[ -n "$pkg" ]] && CURRENT_PENDING["$pkg"]=1
done < <(apt list --upgradable 2>/dev/null | tail -n +2 | awk -F/ '{print $1}')

NOW_EPOCH=$(date +%s)
TMP_STATE="$(mktemp)"
declare -A FIRST_SEEN=()
if [[ -r "$PENDING_STATE" ]]; then
  while IFS=$'\t' read -r pkg ts; do
    [[ -n "$pkg" && -n "$ts" ]] && FIRST_SEEN["$pkg"]="$ts"
  done < "$PENDING_STATE"
fi

old_count=0
for pkg in "${!CURRENT_PENDING[@]}"; do
  ts="${FIRST_SEEN[$pkg]:-$NOW_EPOCH}"
  printf '%s\t%s\n' "$pkg" "$ts" >> "$TMP_STATE"
  age_days=$(( (NOW_EPOCH - ts) / 86400 ))
  if (( age_days > PENDING_DAYS )); then
    old_count=$(( old_count + 1 ))
  fi
done
mv "$TMP_STATE" "$PENDING_STATE"

if (( old_count >= MIN_PENDING )); then
  # Calculamos la antigüedad máxima en días para reportar el "desde hace D días"
  max_age=0
  for pkg in "${!CURRENT_PENDING[@]}"; do
    ts="${FIRST_SEEN[$pkg]:-$NOW_EPOCH}"
    age_days=$(( (NOW_EPOCH - ts) / 86400 ))
    (( age_days > max_age )) && max_age=$age_days
  done
  sample="$(apt list --upgradable 2>/dev/null | tail -n +2 | head -n 8)"
  send_event "pending-old" "$sample" "\"count\":${old_count},\"days\":${max_age}"
fi

# 3) reboot-pending: /var/run/reboot-required con mtime > REBOOT_DAYS días.
if [[ -f /var/run/reboot-required ]]; then
  mtime=$(stat -c %Y /var/run/reboot-required 2>/dev/null || echo 0)
  age_days=$(( (NOW_EPOCH - mtime) / 86400 ))
  if (( age_days > REBOOT_DAYS )); then
    pkgs="$(cat /var/run/reboot-required.pkgs 2>/dev/null | head -n 10)"
    send_event "reboot-pending" "$pkgs" "\"days\":${age_days}"
  fi
fi

exit 0
