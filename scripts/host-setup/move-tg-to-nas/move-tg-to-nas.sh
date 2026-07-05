#!/usr/bin/env bash
# Mueve descargas Telegram (local) al NAS según categoría.
# Si NAS no montado/accesible, sale silencioso (retry mañana).
#
# Comportamiento extra:
#  - .cbr.zip / .cbz.zip: renombrar a .cbr/.cbz y mover a COMICS.
#  - .zip con .cbz/.cbr dentro: extraer los .cbz/.cbr al NAS y borrar zip.
#  - .zip de páginas sueltas (.jpg): re-empaquetar como .cbz al NAS.
#  - .tar con .cbz/.cbr dentro: extraer los .cbz/.cbr al NAS y borrar tar.
#  - .json menores de 1 KB: borrar (basura residual de Telegram).
#  - duplicado en destino con mismo tamaño: borrar origen.
#  - duplicado en destino con tamaño distinto: SOBRESCRIBIR (asumir local = completo).
#
# Clasificación de vídeo (LUI-TSK-0070): antes de decidir PELICULAS vs SERIES se
# limpian del nombre la resolución (1920x1080) y el año, que si no disparan el
# patrón "NxNNN" y mandan películas a SERIES por error.
#
# Notificación (LUI-TSK-0070): si se mueve al menos un fichero, se envía un
# resumen a Telegram vía el webhook watchtower de LUIS. La notificación nunca
# hace fallar el proceso (best-effort); si no se movió nada, silencio.
set -euo pipefail

LOG="$HOME/.local/state/move-tg-to-nas.log"
SRC="$HOME/TelegramDownloadsLocal"
NAS="$HOME/servidorix"

# Notificación Telegram (webhook watchtower de LUIS)
LUIS_URL="http://localhost:3030/api/hooks/watchtower"
ENV_FILE="$HOME/luis/.env"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "=== $(date -Iseconds) ==="

# Envía un mensaje a Telegram vía el webhook de LUIS. Best-effort: cualquier
# fallo (token ausente, jq/curl no disponibles, LUIS caído) se ignora.
notify_telegram() {
    local msg="$1"
    local token
    token=$(grep '^WATCHTOWER_WEBHOOK_TOKEN=' "$ENV_FILE" 2>/dev/null | sed 's/^WATCHTOWER_WEBHOOK_TOKEN=//')
    [[ -z "$token" ]] && return 0
    command -v jq >/dev/null 2>&1 || return 0
    command -v curl >/dev/null 2>&1 || return 0
    local payload
    payload=$(jq -n --arg m "$msg" '{message: $m}')
    curl -fsS --max-time 10 -X POST "${LUIS_URL}?token=${token}" \
        -H 'Content-Type: application/json' \
        -d "$payload" >/dev/null 2>&1 || true
}

if ! ls "$NAS" >/dev/null 2>&1; then
    echo "NAS no accesible. Salgo."
    exit 0
fi
if ! mountpoint -q "$NAS"; then
    echo "NAS sin montar. Salgo."
    exit 0
fi
if [[ ! -d "$SRC" ]]; then
    echo "Sin $SRC. Salgo."
    exit 0
fi

mkdir -p "$NAS/PELICULAS" "$NAS/SERIES" "$NAS/ANIME" "$NAS/LIBROS" "$NAS/COMICS" "$NAS/AUDIOLIBROS"

# Contadores por categoría (para el desglose de la notificación).
declare -A CAT=()

# Mueve un fichero al destino; si ya existe destino lo sobreescribe (asumimos
# local = completo, ver decisión documentada en el bug del 20-jun-2026).
move_to() {
    local src="$1" destdir="$2" name="$3"
    local cat="${destdir##*/}"
    local destpath="$destdir/$name"
    if [[ -e "$destpath" ]]; then
        local sl sn
        sl=$(stat -c%s "$src" 2>/dev/null)
        sn=$(stat -c%s "$destpath" 2>/dev/null)
        if [[ "$sl" == "$sn" ]]; then
            rm "$src" && echo "DUP -> ${cat} (mismo tamaño, origen borrado): $name"
            CAT[$cat]=$(( ${CAT[$cat]:-0} + 1 ))
            return 0
        fi
        # tamaños distintos → sobreescribir con el local
        mv -f "$src" "$destpath" && echo "OW -> ${cat} (sobreescrito, local más completo): $name"
        CAT[$cat]=$(( ${CAT[$cat]:-0} + 1 ))
        return 0
    fi
    mv -n "$src" "$destpath" && echo "OK → ${cat}: $name"
    CAT[$cat]=$(( ${CAT[$cat]:-0} + 1 ))
}

moved=0
skipped=0

# 1) Auto-purga: .json basura
shopt -s nullglob
for f in "$SRC"/*.json; do
    sz=$(stat -c%s "$f")
    if (( sz < 1024 )); then
        rm "$f" && echo "GC: borrado json basura ($sz bytes): $(basename "$f")"
    fi
done

# 2) Procesar archivos ZIP/TAR de cómics ANTES del bucle general.
for f in "$SRC"/*.zip; do
    [[ -f "$f" ]] || continue
    name=$(basename "$f")
    # Caso A: .cbr.zip o .cbz.zip → un solo cómic, renombrar y mover.
    if [[ "${name,,}" =~ \.cb[rz]\.zip$ ]]; then
        newname="${name%.zip}"
        mv "$f" "$SRC/$newname" && move_to "$SRC/$newname" "$NAS/COMICS" "$newname" && moved=$((moved+1))
        continue
    fi
    # Caso B: el zip CONTIENE .cbz/.cbr → extraer cada uno.
    listing=$(unzip -l "$f" 2>/dev/null || true)
    if echo "$listing" | grep -qiE '\.(cbz|cbr)$'; then
        tmpdir=$(mktemp -d -p "$SRC")
        unzip -qq -j -o "$f" '*.cbz' '*.cbr' '*.CBZ' '*.CBR' -d "$tmpdir" 2>/dev/null || true
        extracted=0
        for inner in "$tmpdir"/*; do
            [[ -f "$inner" ]] || continue
            iname=$(basename "$inner")
            move_to "$inner" "$NAS/COMICS" "$iname" && extracted=$((extracted+1))
        done
        rm -rf "$tmpdir"
        if (( extracted > 0 )); then
            rm "$f" && echo "OK → COMICS (extraído $extracted del zip): $name"
            moved=$((moved+extracted))
        else
            echo "ZIP sin cómics extraíbles: $name"
            skipped=$((skipped+1))
            continue
        fi
        continue
    fi
    # Caso C: el zip contiene .jpg sueltos (un cómic empaquetado raro)
    # → renombrar el zip mismo a .cbz (un cbz es básicamente un zip).
    if echo "$listing" | grep -qiE '\.(jpe?g|png|webp|gif)$'; then
        newname="${name%.zip}.cbz"
        mv "$f" "$SRC/$newname" && move_to "$SRC/$newname" "$NAS/COMICS" "$newname" && moved=$((moved+1))
        continue
    fi
    echo "SKIP (zip sin cómics ni imágenes): $name"
    skipped=$((skipped+1))
done

# 3) TARs con cómics dentro
for f in "$SRC"/*.tar; do
    [[ -f "$f" ]] || continue
    name=$(basename "$f")
    listing=$(tar -tf "$f" 2>/dev/null || true)
    if echo "$listing" | grep -qiE '\.(cbz|cbr)$'; then
        tmpdir=$(mktemp -d -p "$SRC")
        # Extraer sólo los .cbz/.cbr, sin subdirectorios
        tar -xf "$f" -C "$tmpdir" --wildcards '*.cbz' '*.cbr' '*.CBZ' '*.CBR' 2>/dev/null || true
        # Aplanar (mover archivos a la raíz del tmpdir si están en subcarpetas)
        find "$tmpdir" -mindepth 2 -type f -exec mv -t "$tmpdir" {} + 2>/dev/null || true
        extracted=0
        for inner in "$tmpdir"/*; do
            [[ -f "$inner" ]] || continue
            iname=$(basename "$inner")
            move_to "$inner" "$NAS/COMICS" "$iname" && extracted=$((extracted+1))
        done
        rm -rf "$tmpdir"
        if (( extracted > 0 )); then
            rm "$f" && echo "OK → COMICS (extraído $extracted del tar): $name"
            moved=$((moved+extracted))
        else
            echo "TAR sin cómics extraíbles: $name"
            skipped=$((skipped+1))
        fi
        continue
    fi
    echo "SKIP (tar sin cómics): $name"
    skipped=$((skipped+1))
done

# 4) Bucle general para el resto de ficheros
for f in "$SRC"/*; do
    [[ -f "$f" ]] || continue
    name=$(basename "$f")
    ext="${name##*.}"
    ext_lc="${ext,,}"
    dest=""

    case "$ext_lc" in
        mkv|mp4|avi|mov|webm|m4v)
            # Nombre "limpio" sólo para decidir la carpeta: quitamos resolución
            # (1920x1080) y año, que si no disparan el patrón NxNNN de serie y
            # mandan películas a SERIES por error (LUI-TSK-0070).
            name_series=$(echo "$name" | sed -E 's/\(?[0-9]{3,4}[[:space:]]*[xX][[:space:]]*[0-9]{3,4}\)?//g; s/\(?(19|20)[0-9]{2}\)?//g')
            if [[ "$name" =~ ^\[[^]]+\] ]]; then
                dest="$NAS/ANIME"
            elif echo "$name_series" | grep -qiE '(s[0-9]{1,2}e[0-9]{1,3}|[0-9]{1,2}x[0-9]{1,3}|season|temporada|capitulo|episode|episodio)'; then
                dest="$NAS/SERIES"
            else
                dest="$NAS/PELICULAS"
            fi
            ;;
        epub|mobi|azw3|fb2)
            dest="$NAS/LIBROS"
            ;;
        pdf)
            sz=$(stat -c%s "$f")
            if (( sz > 1048576 )); then
                dest="$NAS/LIBROS"
            else
                echo "SKIP (pdf pequeño): $name"; skipped=$((skipped+1)); continue
            fi
            ;;
        cbz|cbr|cb7|cbt)
            dest="$NAS/COMICS"
            ;;
        mp3|m4a|flac|ogg|opus|wav)
            if command -v ffprobe >/dev/null 2>&1; then
                secs=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null | cut -d. -f1)
                if [[ ${secs:-0} -gt 1800 ]]; then
                    dest="$NAS/AUDIOLIBROS"
                else
                    echo "SKIP (audio corto, ${secs:-?}s): $name"; skipped=$((skipped+1)); continue
                fi
            else
                echo "SKIP (ffprobe no instalado): $name"; skipped=$((skipped+1)); continue
            fi
            ;;
        zip|tar|json)
            # ya procesados arriba; si llegaron aquí es porque no entraron en ningún caso
            continue
            ;;
        *)
            echo "SKIP (ext desconocida .$ext_lc): $name"; skipped=$((skipped+1)); continue
            ;;
    esac

    if [[ -n "$dest" ]]; then
        move_to "$f" "$dest" "$name" && moved=$((moved+1))
    fi
done

echo "Resultado: $moved movidos, $skipped saltados."

# 5) Notificación Telegram (sólo si se movió algo).
if (( moved > 0 )); then
    detail=""
    for cat in PELICULAS SERIES ANIME LIBROS COMICS AUDIOLIBROS; do
        c=${CAT[$cat]:-0}
        (( c == 0 )) && continue
        case "$cat" in
            PELICULAS)   emoji="🎬" ;;
            SERIES)      emoji="📺" ;;
            ANIME)       emoji="🎌" ;;
            LIBROS)      emoji="📚" ;;
            COMICS)      emoji="📖" ;;
            AUDIOLIBROS) emoji="🎧" ;;
            *)           emoji="📁" ;;
        esac
        detail+=$'\n'"${emoji} ${cat}: ${c}"
    done
    notify_telegram "✅ move-tg-to-nas: ${moved} movidos, ${skipped} saltados${detail}"
fi
