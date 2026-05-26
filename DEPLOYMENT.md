# Deployment

This guide lets anyone reproduce a full LUIS deployment (Telegram bot, Home
Assistant, local LLM, cluster watcher, web UI) with their **own** credentials
and network. Nothing here is specific to a particular machine: every host, IP,
port, path and secret comes from the environment.

## 1. Prerequisites

- **Docker** + **Docker Compose v2** (`docker compose version`)
- A reachable **OpenAI-compatible local LLM** endpoint (Ollama, llama.cpp,
  vLLM, LM Studio, LiteLLM…)
- A **Telegram bot** (optional but recommended)
- A **Home Assistant** instance (optional)
- Nodes to monitor with the **cluster watcher** (optional)

## 2. Get the code

```bash
git clone <repo-url> luis
cd luis
```

The repo root contains `Dockerfile` and `docker-compose.yml`; the compose
`build.context` is `.`, so run compose from the repo root.

## 3. Configure

```bash
cp .env.example .env
$EDITOR .env
```

`.env` is gitignored and never baked into the image — it is read at runtime by
Docker Compose. See the full variable reference in section 6.

## 4. How to obtain each credential

### Telegram bot token (`TELEGRAM_BOT_TOKEN`)
1. Open Telegram, talk to **@BotFather**.
2. `/newbot`, follow the prompts.
3. Copy the token into `TELEGRAM_BOT_TOKEN`.

### Telegram chat IDs (`TELEGRAM_ALLOWED_CHAT_IDS`, `TELEGRAM_NOTIFY_CHAT_ID`)
1. Talk to **@userinfobot**, it replies with your numeric chat ID.
2. `TELEGRAM_ALLOWED_CHAT_IDS` is a comma-separated allowlist — only these
   chats may use the bot.
3. `TELEGRAM_NOTIFY_CHAT_ID` is where unsolicited alerts (cluster, etc.) go.
   Leave empty to fall back to the first allowed chat.

### Home Assistant long-lived token (`HA_TOKEN`)
1. HA → your profile → **Long-Lived Access Tokens** → *Create Token*.
2. `HA_BASE_URL` is your HA URL (e.g. `http://<ha-ip>:8123`).
3. `HA_AGENT_ID` is the conversation agent entity (e.g.
   `conversation.home_assistant` or an Ollama/Assist agent).

### Local LLM (`LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY`)
- Point `LOCAL_LLM_BASE_URL` at your endpoint (Ollama: `http://<ip>:11434`;
  LiteLLM/OpenAI-style: `http://<ip>:8080/v1`).
- `LOCAL_LLM_MODEL` is the model name served there.
- `LOCAL_LLM_API_KEY` only if your endpoint requires it (LiteLLM).

### Web search (`WEB_SEARCH_BASE_URL`, optional)
- A self-hosted **SearXNG** base URL, e.g. `http://<ip>:8888`.

### YouTube + Whisper (optional)
- `luis youtube <url>` (CLI) and `/youtube <url>` (Telegram) need:
  - `yt-dlp` + `ffmpeg` in the runtime image (already in the Dockerfile).
  - `WHISPER_BASE_URL` pointing at an OpenAI-compatible `/v1/audio/transcriptions` endpoint
    (e.g. LiteLLM with whisper.cpp at `http://<litellm-host>:8080`).
- Without `WHISPER_BASE_URL` the command answers "not configured" and the rest of the bot keeps working.
- See the `WHISPER_*` and `YOUTUBE_*` variables in the reference table below.

## 5. Build and run

```bash
docker compose build
docker compose up -d
docker compose logs -f
```

On a healthy start you should see `Assistant ready` and, if the cluster watcher
is enabled, `Cluster watcher started`.

## 6. Environment variable reference

> Keep `.env.example` in sync with this table.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ASSISTANT_NAME` | no | `luis` | Display name |
| `LOG_LEVEL` | no | `info` | pino level |
| `LLM_PROVIDER` | no | `local` | `local` or `cloud` |
| `LOCAL_LLM_BASE_URL` | **yes** | — | OpenAI-compatible LLM base URL |
| `LOCAL_LLM_MODEL` | **yes** | — | Model name |
| `LOCAL_LLM_API_KEY` | no | — | Only if the endpoint needs auth |
| `LOCAL_LLM_TIMEOUT_MS` | no | `120000` | Request timeout |
| `ALLOW_CLOUD_LLM` | no | `false` | Allow cloud LLM providers |
| `WEB_ENABLED` | no | `true` (compose) | Enable LAN web UI |
| `WEB_PUBLISHED_PORT` | no | `3030` | Host port mapped to container `:3000` |
| `WATCHTOWER_WEBHOOK_TOKEN` | no | — | Shared secret for the Watchtower webhook (empty = disabled) |
| `WEB_SEARCH_BASE_URL` | no | — | SearXNG base URL |
| `URL_FETCH_ALLOW_PRIVATE` | no | `false` | Allow fetching private-network URLs |
| `URL_FETCH_ALLOWLIST` | no | — | CSV of allowed private hosts/IPs |
| `TELEGRAM_BOT_TOKEN` | for bot | — | BotFather token |
| `TELEGRAM_ALLOWED_CHAT_IDS` | for bot | — | CSV allowlist of chat IDs |
| `TELEGRAM_NOTIFY_CHAT_ID` | no | first allowed | Target for alerts |
| `HA_BASE_URL` | for HA | — | Home Assistant URL |
| `HA_TOKEN` | for HA | — | HA long-lived token |
| `HA_LANGUAGE` | no | `es` | HA conversation language |
| `HA_AGENT_ID` | no | — | HA conversation agent entity |
| `CLUSTER_ENABLED` | no | `false` (compose) | Enable the cluster watcher |
| `CLUSTER_N2_IP` | if cluster | — | IP of node n2 |
| `CLUSTER_N3_IP` | if cluster | — | IP of node n3 |
| `CLUSTER_N4_IP` | if cluster | — | IP of node n4 |
| `PROMETHEUS_ENABLED` | no | `false` | Enable on-demand "is anything down?" checks |
| `PROMETHEUS_BASE_URL` | if prometheus | — | Prometheus base URL, e.g. `http://<ip>:9090` |
| `PROMETHEUS_TIMEOUT_MS` | no | `8000` | Prometheus query timeout |
| `WHISPER_BASE_URL` | for /youtube | — | OpenAI-compatible Whisper endpoint, e.g. `http://<litellm-host>:8080` |
| `WHISPER_MODEL` | no | `whisper-1` | Whisper model name |
| `WHISPER_API_KEY` | no | — | Only if the endpoint requires auth |
| `WHISPER_TIMEOUT_MS` | no | `600000` | Per-request timeout (10 min default for long audios) |
| `YOUTUBE_YTDLP_BIN` | no | `yt-dlp` | Path/name of the yt-dlp binary |
| `YOUTUBE_DEFAULT_LANGUAGE` | no | `es` | Preferred subtitle language; falls back to `en` |
| `YOUTUBE_SUMMARY_CHUNK_CHARS` | no | `8000` | Chunk size threshold for long-transcript summaries |
| `YOUTUBE_SUBTITLE_TIMEOUT_MS` | no | `60000` | yt-dlp subtitle fetch timeout |
| `YOUTUBE_AUDIO_TIMEOUT_MS` | no | `600000` | yt-dlp audio extraction timeout (10 min for long videos) |
| `CONTAINER_NAME` | no | `luis` | Docker container name |

When `CLUSTER_ENABLED=true`, the three `CLUSTER_N*_IP` values are **required**;
the daemon fails fast at startup with an actionable message if any is missing.
The same applies to `PROMETHEUS_BASE_URL` when `PROMETHEUS_ENABLED` is not
`false` — set the URL or set `PROMETHEUS_ENABLED=false`.

## 7. Cluster watcher topology

The watcher probes 8 services across 3 nodes every 60s (single retry after 30s
before alerting, no notification spam, alert on fall **and** recovery):

| Node | Service | Port | Check |
|---|---|---|---|
| n2 | LiteLLM | 8080 | `GET /health/liveliness` → 200 |
| n2 | Ollama | 11434 | `GET /api/tags` → 200 |
| n2 | Open WebUI | 3000 | `GET /` → 200 |
| n3 | Ollama | 11434 | `GET /api/tags` → 200 |
| n3 | n8n | 5678 | `GET /healthz` → 200 |
| n4 | Ollama | 11434 | `GET /api/tags` → 200 |
| n4 | Qdrant | 6333 | `GET /healthz` → 200 |
| n4 | Postgres | 5432 | TCP connect |

CLI: `luis cluster status` (live table) / `luis cluster history` (last 10
incidents). Telegram: `/cluster`, `/cluster historial`, or natural language
("estado del cluster").

## 8. Prometheus down-check (optional)

Separate from the cluster watcher, LUIS can answer **"is anything down?"** on
demand by querying a Prometheus instance — no watcher, no proactive alerts, it
only runs when the user asks. It combines three signals: `up==0` (scrape
targets / exporters down), `probe_success==0` (HTTP services checked via
blackbox-exporter) and Prometheus alerts in the `firing` state.

Opt-in: set `PROMETHEUS_ENABLED=true` and `PROMETHEUS_BASE_URL` to your
Prometheus endpoint. If Prometheus runs in a different Docker network than
LUIS, point `PROMETHEUS_BASE_URL` at the **host IP** (e.g.
`http://<host-ip>:9090`), not a Docker service name unreachable from LUIS's
network.

Channels:
- Telegram: `/caidos`, or natural language ("¿hay algo caído?", "¿está todo bien?").
- Web: a down-check question to `POST /api/ask` or `POST /api/chat` is answered
  from Prometheus instead of the LLM; `GET /api/prometheus/status` returns the
  structured report as JSON.

## 9. Watchtower → Telegram through LUIS (optional)

Instead of letting Watchtower notify Telegram directly (raw text, separate
formatting), point it at LUIS so its messages go through the same notification
pipeline and look like `/cluster`.

**On the LUIS host** — set a shared secret and restart:

```
WATCHTOWER_WEBHOOK_TOKEN=<a-long-random-string>
```

LUIS then exposes `POST /api/hooks/watchtower?token=<secret>` (only when the
token is set; bad/missing token → 401). It relays the payload to
`TELEGRAM_NOTIFY_CHAT_ID`.

**On each host running Watchtower** — replace the `telegram://…` notification
URL with the LUIS webhook. Recommended: a small `docker-compose.yml` so the
config is editable and reproducible (token kept in a local `.env`, never
committed):

```yaml
services:
  watchtower:
    # NOTA: usa el fork mantenido; containrrr/watchtower está archivado y
    # casca con Docker moderno (client API too old).
    image: nickfedor/watchtower:latest
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      WATCHTOWER_SCHEDULE: "0 30 4 * * *"          # UTC
      WATCHTOWER_LABEL_ENABLE: "true"               # opt-in: solo contenedores etiquetados
      WATCHTOWER_CLEANUP: "true"
      WATCHTOWER_NOTIFICATION_REPORT: "true"
      WATCHTOWER_NO_STARTUP_MESSAGE: "true"         # sin banner inútil de arranque
      WATCHTOWER_NOTIFICATIONS: shoutrrr
      WATCHTOWER_NOTIFICATIONS_HOSTNAME: "<host>"   # n2 / servidorix / …
      WATCHTOWER_NOTIFICATION_URL: >-
        generic+http://<luis-host>:<WEB_PUBLISHED_PORT>/api/hooks/watchtower?token=${WATCHTOWER_WEBHOOK_TOKEN}
      # JSON compacto que LUIS traduce a un resumen en español. Ojo: en
      # docker-compose los `$` de Go-template se escriben `$$` (si no, compose
      # los interpola). El formateador (src/modules/watchtower) lee este JSON
      # (incluido cuando shoutrrr lo envuelve en `message`).
      WATCHTOWER_NOTIFICATION_TEMPLATE: '{{- if .Report -}}{"host":"{{.Host}}","scanned":{{len .Report.Scanned}},"updated":[{{range $$i,$$e := .Report.Updated}}{{if $$i}},{{end}}"{{$$e.Name}}"{{end}}],"failed":[{{range $$i,$$e := .Report.Failed}}{{if $$i}},{{end}}"{{$$e.Name}}"{{end}}]}{{- else -}}{"message":"sin reporte"}{{- end -}}'
```

LUIS convierte ese reporte en un aviso conciso en español:
`✅ N actualizados: …` / `⚠️ N con fallo: …` / `Sin cambios (N revisados)`.
Si se omite la plantilla, llega solo la primera línea del texto de Watchtower
(sin volcado).

Test it without waiting for the schedule:

```bash
curl -s -X POST "http://<luis-host>:<port>/api/hooks/watchtower?token=<secret>" \
  -H 'Content-Type: application/json' \
  -d '{"host":"n2","updated":[{"name":"luis","image":"luis:local","old":"a1","new":"b2"}],"scanned":12}'
```

You should get the formatted message in your Telegram notify chat.

## 10. Updating an existing deployment

**Preferred — git on the server:**

```bash
ssh <host> 'cd ~/luis && git pull && docker compose build --no-cache && docker compose up -d --force-recreate'
```

**Rsync workflow (when the server is not a git checkout):**

```bash
# context = repo root; PROJECT_DIR = remote project dir (e.g. ~/app)
rsync -azc --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '/config' \
  ./ user@host:PROJECT_DIR/
# then, on the server, from the dir holding docker-compose.yml:
ssh user@host 'cd COMPOSE_DIR && docker compose build --no-cache && docker compose up -d --force-recreate'
```

Two non-obvious rules, both of which have bitten this project:

- Use `-c` (checksum). `rsync -a` preserves mtimes, so its default size+mtime
  quick-check can treat a stale remote file as up to date and never send it.
- Anchor the exclude as `/config` (leading slash = transfer root only). An
  unanchored `--exclude config` also matches `src/infrastructure/config/` and
  silently skips `load-config.js`.

Prefer the git-on-server workflow above; it sidesteps both pitfalls entirely.
