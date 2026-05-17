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
| `CONTAINER_NAME` | no | `luis` | Docker container name |

When `CLUSTER_ENABLED=true`, the three `CLUSTER_N*_IP` values are **required**;
the daemon fails fast at startup with an actionable message if any is missing.

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

## 8. Updating an existing deployment

**Preferred — git on the server:**

```bash
ssh <host> 'cd ~/luis && git pull && docker compose build --no-cache && docker compose up -d --force-recreate'
```

**Rsync workflow (when the server is not a git checkout):**

```bash
DEPLOY_HOST=user@host DEPLOY_PATH=~/luis/app ./scripts/deploy.sh --rebuild
```

`scripts/deploy.sh` uses checksum-based, correctly-anchored excludes — do not
hand-roll the rsync (an unanchored `--exclude config` silently skips
`src/infrastructure/config/`, and `rsync -a` mtime quick-check can skip stale
files; both have bitten this project).
