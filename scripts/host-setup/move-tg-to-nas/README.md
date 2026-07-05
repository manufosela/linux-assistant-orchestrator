# move-tg-to-nas

Mueve las descargas de Telegram Desktop del portátil (`~/TelegramDownloadsLocal`)
al NAS (`~/servidorix`, montado por sshfs sobre `/media/raid5`), clasificándolas
por tipo en `PELICULAS/`, `SERIES/`, `ANIME/`, `LIBROS/`, `AUDIOLIBROS/` y
`COMICS/`.

Es la **fase 1** del pipeline de descargas (lado portátil). La **fase 2** es
`scripts/organize_nightly/` (lado `servidorix`), que reorganiza con LLM el buzón
`/media/raid5/TelegramDownloads/`. Son buzones distintos.

## Componentes

- **`move-tg-to-nas.sh`** — script principal. Clasifica por extensión y, para
  vídeo, distingue PELICULAS / SERIES / ANIME por patrones del nombre.
- **`move-tg-to-nas.service`** / **`move-tg-to-nas.timer`** — unidades systemd de
  usuario. El timer dispara el servicio a diario a las 03:00.

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

Si se mueve al menos un fichero, se envía un resumen a Telegram vía el webhook
watchtower de LUIS. Es **best-effort**: si LUIS está caído, falta el token o el
`.env` no existe, el move **no falla** (sale 0 igualmente). Si no se mueve nada,
no notifica.

La URL y el token son configurables por entorno, porque LUIS no siempre corre en
`localhost`:

| Variable | Por defecto | Uso |
|----------|-------------|-----|
| `WATCHTOWER_URL` | `http://localhost:3030/api/hooks/watchtower` | endpoint del webhook |
| `WATCHTOWER_WEBHOOK_TOKEN` | — | token; si no, se lee del `.env` |
| `WATCHTOWER_ENV_FILE` | `~/luis/.env` | `.env` de donde leer el token |

En el **host de LUIS** (servidorix) los valores por defecto ya funcionan. En el
**portátil**, donde LUIS no corre en localhost, se configura vía la unidad
systemd, que carga `~/.config/move-tg-to-nas.env` (no versionado, contiene el
secreto):

```ini
# ~/.config/move-tg-to-nas.env  (chmod 600, NO se sube al repo)
WATCHTOWER_URL=http://192.168.1.7:3030/api/hooks/watchtower
WATCHTOWER_WEBHOOK_TOKEN=<token de servidorix:~/luis/.env>
```

El `move-tg-to-nas.service` lo carga con `EnvironmentFile=-%h/.config/move-tg-to-nas.env`
(el `-` lo hace opcional).

## Despliegue

El script canónico vive en este repo; la copia ejecutable está en
`~/.local/bin/move-tg-to-nas.sh`. Para actualizar tras cambios:

```bash
cp scripts/host-setup/move-tg-to-nas/move-tg-to-nas.sh ~/.local/bin/move-tg-to-nas.sh
cp scripts/host-setup/move-tg-to-nas/move-tg-to-nas.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now move-tg-to-nas.timer
```

Ejecutar una pasada manual:

```bash
~/.local/bin/move-tg-to-nas.sh
tail -n 40 ~/.local/state/move-tg-to-nas.log
```

## Log

`~/.local/state/move-tg-to-nas.log` (se acumula; cada ejecución empieza con una
cabecera `=== <timestamp> ===`).
