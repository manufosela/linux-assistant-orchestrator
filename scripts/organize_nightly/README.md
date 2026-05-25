# organize_nightly

Cron nightly que organiza `/media/raid5/TelegramDownloads/` clasificando
los archivos por tipo y moviéndolos a sus carpetas en el NAS (`PELICULAS/`,
`SERIES/<nombre>/`, `ANIME/`, `LIBROS/`, `AUDIOLIBROS/`, `COMICS/`).

## Componentes

- **`organize_nightly.py`** — script principal en Python. Clasifica por
  extensión y, para vídeos, usa el LLM local + heurística determinista.
- **`organize_nightly_wrapped.sh`** — wrapper para cron: ejecuta el script,
  cuenta resultados y notifica a Telegram vía webhook de LUIS si hay errores.

## Despliegue

El cron en `servidorix` invoca `organize_nightly_wrapped.sh` que está en
`/media/raid5/SRC/`. Para actualizar tras cambios en este repo:

```bash
scp scripts/organize_nightly/organize_nightly.py servidorix:/media/raid5/SRC/
scp scripts/organize_nightly/organize_nightly_wrapped.sh servidorix:/media/raid5/SRC/
```

(Backup antes:
```bash
ssh servidorix 'cp /media/raid5/SRC/organize_nightly.py /media/raid5/SRC/organize_nightly.py.bak.$(date +%Y%m%d-%H%M%S)'
```
.)

## Variables de entorno requeridas

- `BASE_DIR` — raíz del NAS (ej: `/media/raid5`)
- `LOCAL_LLM_BASE_URL` — endpoint OpenAI-compatible (ej: `http://192.168.1.11:11434/v1`)
- `LOCAL_LLM_MODEL` — modelo a usar (ej: `gemma4:e4b`)

## Detección de series

Dos capas:

1. **Heurística determinista (`detect_series_groups`)**:
   - Agrupa archivos por base name (strip de año + resolución + número final)
   - Si 2+ archivos comparten esa base → todos son serie con ese prefijo
   - Resuelve el caso "Saga 1.mp4, Saga 2.mp4..." que el LLM no detecta por
     falta de sufijo formal de episodio.

2. **LLM local** (`call_llm_for_videos`):
   - Solo para los archivos que la heurística NO clasificó
   - Patrones formales: `1xNN`, `S01E02`, `01x05`, `Cap. NN`, `Episodio NN`
   - Contexto del NAS (series ya catalogadas) para emparejar episodios nuevos
