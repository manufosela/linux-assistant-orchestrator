# move-tg-to-nas

Mueve las descargas de Telegram Desktop del portátil (`~/TelegramDownloadsLocal`)
al NAS (`~/servidorix`, montado por sshfs sobre `/media/raid5`), clasificándolas
por tipo en `PELICULAS/`, `SERIES/`, `ANIME/`, `LIBROS/`, `AUDIOLIBROS/` y
`COMICS/`.

Es la **fase 1** del pipeline de descargas (lado portátil). La **fase 2** es
`scripts/organize_nightly/` (lado `servidorix`), que reorganiza con LLM el buzón
`/media/raid5/TelegramDownloads/`. Son buzones distintos.

## Componentes

Lado **portátil** (efímero):

- **`move-tg-to-nas.sh`** — script principal. Clasifica por extensión y, para
  vídeo, distingue PELICULAS / SERIES / ANIME por patrones del nombre. Al mover
  algo, deja un report en `<NAS>/.move-reports/`.
- **`move-tg-to-nas.service`** / **`move-tg-to-nas.timer`** — unidades systemd de
  usuario. El timer dispara el servicio a diario a las 03:00.

Lado **servidorix** (siempre encendido):

- **`notify-move-reports.sh`** — lee los reports del portátil en
  `/media/raid5/.move-reports/` y es quien envía el aviso a Telegram vía el
  webhook local de LUIS. Cada report se borra sólo si el POST tuvo éxito.

## Reglas de clasificación

| Tipo | Destino | Criterio |
|------|---------|----------|
| Vídeo `[grupo]…` | `ANIME` | nombre empieza por `[...]` |
| Vídeo con `S01E02`, `1x05`, `temporada`, `capitulo`, `episodio` | `SERIES` | patrón de episodio |
| Resto de vídeo | `PELICULAS` | |
| `.epub/.mobi/.azw3/.fb2` | `LIBROS` | |
| `.pdf` > 1 MB | `LIBROS` | los `.pdf` pequeños se dejan (basura) |
| `.cbz/.cbr/.cb7/.cbt` | `COMICS` | |
| Audio > 30 min | `AUDIOLIBROS` | requiere `ffprobe`; audio corto se deja |
| `.zip/.tar` con cómics | `COMICS` | se extraen los `.cbz/.cbr` |
| `.json` < 1 KB | — | se borra (residuo de Telegram) |

Antes de decidir PELICULAS vs SERIES se limpian del nombre la **resolución**
(`1920x1080`) y el **año**, porque `1920x1080` contiene `20x108` y disparaba el
patrón de serie `NxNNN`, mandando películas a `SERIES` por error (LUI-TSK-0070).

Duplicados: si el destino ya existe con el mismo tamaño se borra el origen; con
tamaño distinto se sobreescribe (se asume que el local es el completo).

## Notificación

El aviso a Telegram lo emite **siempre servidorix**, nunca el portátil. Motivo: el
portátil es efímero (puede estar apagado, suspendido o fuera de casa) y no debe
llevar el token del webhook. El flujo es:

1. El portátil, si movió ≥1 fichero, escribe el resumen ya formateado en
   `<NAS>/.move-reports/move-tg-<host>-<timestamp>.txt`. Best-effort: si no puede
   escribir, el move **no falla**. Si no movió nada, no deja report.
2. `notify-move-reports.sh` en servidorix (cron cada ~5 min) recorre esos `.txt`,
   hace el POST al webhook local de LUIS `POST /api/hooks/notify` (`localhost:3030`)
   con el token de `~/luis/.env`, y borra cada report sólo si el envío tuvo éxito
   (si LUIS está caído, se reintenta a la siguiente pasada). Se usa `/notify`
   (reemite el texto tal cual) y NO `/watchtower`, que aplanaría el mensaje a la
   primera línea y perdería el desglose por categoría.

Así el portátil no habla con LUIS ni maneja secretos, y ningún aviso se pierde
aunque el portátil se apague justo después de mover.

`notify-move-reports.sh` acepta overrides por entorno: `BASE_DIR` (raíz del NAS),
`WATCHTOWER_URL`, `WATCHTOWER_WEBHOOK_TOKEN` y `WATCHTOWER_ENV_FILE`.

## Despliegue

### Portátil

El script canónico vive en este repo; la copia ejecutable está en
`~/.local/bin/move-tg-to-nas.sh`. Para actualizar tras cambios:

```bash
cp scripts/host-setup/move-tg-to-nas/move-tg-to-nas.sh ~/.local/bin/move-tg-to-nas.sh
cp scripts/host-setup/move-tg-to-nas/move-tg-to-nas.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now move-tg-to-nas.timer
```

### Servidorix (relay de avisos)

```bash
scp scripts/host-setup/move-tg-to-nas/notify-move-reports.sh servidorix:/media/raid5/SRC/
ssh servidorix 'chmod +x /media/raid5/SRC/notify-move-reports.sh'
# Añadir al crontab de servidorix (una vez):
#   */5 * * * * BASE_DIR=/media/raid5 /media/raid5/SRC/notify-move-reports.sh >/dev/null 2>&1
```

Ejecutar una pasada manual:

```bash
~/.local/bin/move-tg-to-nas.sh
tail -n 40 ~/.local/state/move-tg-to-nas.log
```

## Log

`~/.local/state/move-tg-to-nas.log` (se acumula; cada ejecución empieza con una
cabecera `=== <timestamp> ===`).
