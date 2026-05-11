# Assistant

A local Linux personal assistant that runs as a background service and acts as a private engineering and personal assistant.

The assistant is designed around a **local-first, privacy-first** principle: private data stays in your home network. Cloud LLM providers are disabled by default.

---

## What the first version includes

- **CLI** (`luis`) — interactive REPL plus non-interactive subcommands, sharing the same services as Telegram and the workers. Configurable per-user via `~/.config/luis/config.json`.
- **Local web UI** — token-protected HTTP API + minimal vanilla-JS dashboard, reachable from the LAN
- **Telegram bot** with commands: `/status`, `/downloads-rules`, `/llm-status`, `/help`
- **Authorized chat validation** — only configured Telegram chat IDs can use the bot
- **Downloads watcher** — monitors a directory and organizes new files automatically
- **Rule-based file classifier** — classifies files by extension using a JSON config
- **LLM file classifier** — optional fallback to local LLM for unmatched files
- **Local LLM provider abstraction** — connects to any OpenAI-compatible local endpoint (Ollama, llama.cpp, vLLM, LM Studio)
- **Structured logging** — all events logged with pino, no prompt content logged by default
- **Security placeholders** — dangerous command detection, approval service, command policy
- **Unit tests** — core logic covered with Node.js built-in test runner

---

## What is intentionally not implemented yet

- Email integration (Gmail API, Microsoft Graph)
- Calendar integration (Google Calendar, Microsoft Graph)
- Planning Game integration
- Coding agent execution (Codex, Claude CLI, Gemini CLI, Karajan)
- Shell command execution for external tasks
- Web UI or CLI approval flow
- Natural language Telegram commands

These modules exist as typed interfaces/placeholders and will be filled in future iterations.

---

## Requirements

- **Node.js >= 20**
- **pnpm**
- A running local LLM endpoint (Ollama, llama.cpp, vLLM, LM Studio, or compatible)
- A Telegram bot token (see below)

---

## Installation

```bash
cd assistant
pnpm install
```

---

## Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Description | Default |
|---|---|---|
| `ASSISTANT_NAME` | Display name of the assistant | `karajan-assistant` |
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token | *(required)* |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Comma-separated list of allowed chat IDs | *(required)* |
| `DOWNLOADS_PATH` | Directory to watch for new downloads | `/home/manu/Descargas` |
| `DOWNLOAD_RULES_PATH` | Path to your download rules JSON file | `./config/download-rules.json` |
| `ENABLE_LLM_FILE_CLASSIFICATION` | Use LLM to classify files with no matching rule | `false` |
| `LLM_PROVIDER` | LLM provider to use (`local` or `cloud`) | `local` |
| `LOCAL_LLM_BASE_URL` | Base URL of your local LLM HTTP API | `http://192.168.1.10:11434` |
| `LOCAL_LLM_MODEL` | Model name to use | *(required for completions)* |
| `LOCAL_LLM_TIMEOUT_MS` | Timeout for LLM requests in ms | `120000` |
| `ALLOW_CLOUD_LLM` | Allow cloud LLM providers | `false` |

---

## Creating a Telegram bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the instructions
3. Copy the token BotFather gives you into `TELEGRAM_BOT_TOKEN`

---

## Finding your Telegram chat ID

1. Search for **@userinfobot** on Telegram
2. Send it any message
3. It will reply with your chat ID

Alternatively, send a message to your bot and then open:
```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```
Look for `"chat": {"id": ...}` in the response.

---

## Configuring downloads

Copy the example rules file:

```bash
cp config/download-rules.example.json config/download-rules.json
```

Edit `config/download-rules.json` to match your directory structure. Each rule has:

- `name` — human-readable label
- `extensions` — list of file extensions to match (case-insensitive)
- `targetPath` — absolute path to move matching files to

Example:

```json
{
  "rules": [
    {
      "name": "PDF documents",
      "extensions": [".pdf"],
      "targetPath": "/home/manu/Documentos/PDF"
    }
  ]
}
```

The assistant will watch `DOWNLOADS_PATH` and automatically move new files to the appropriate folder.

---

## Configuring the local LLM provider

The assistant supports any OpenAI-compatible HTTP API. Examples:

### Ollama

```env
LOCAL_LLM_BASE_URL=http://localhost:11434
LOCAL_LLM_MODEL=llama3
```

Start Ollama: `ollama serve`

### llama.cpp server

```env
LOCAL_LLM_BASE_URL=http://localhost:8080
LOCAL_LLM_MODEL=my-model
```

### vLLM

```env
LOCAL_LLM_BASE_URL=http://192.168.1.10:8000
LOCAL_LLM_MODEL=mistral-7b
```

The assistant assumes an OpenAI-compatible `/v1/chat/completions` endpoint.
Use `/llm-status` on Telegram to verify connectivity.

---

## Running tests

```bash
pnpm test
```

Tests use Node.js built-in test runner — no additional framework required.

---

## CLI: `luis`

`luis` (LLM User Inference Shell) is the local-first command-line interface to the assistant. Same services as Telegram and the web UI, no cloud LLM unless explicitly enabled.

### Install the binary globally

```bash
pnpm install
pnpm link --global    # exposes `luis` on your PATH
```

After this, the `luis` command is available system-wide.

To remove it later:

```bash
pnpm unlink --global
```

### Per-user configuration

`luis` reads its configuration from `~/.config/luis/config.json` (or `$XDG_CONFIG_HOME/luis/config.json` when `XDG_CONFIG_HOME` is set; override with `LUIS_CONFIG=/path/to/file`). This means **`luis` works from any directory** — no `.env` needed in the current working directory.

```json
{
  "llm": {
    "provider": "local",
    "allowCloudLlm": false,
    "local": {
      "baseUrl": "http://192.168.1.11:11434/v1",
      "model": "gemma4:e4b",
      "timeoutMs": 600000
    }
  }
}
```

`baseUrl` accepts both `http://host:port` and `http://host:port/v1` — the `/v1` is detected and normalised internally. Set the file mode to `600` if you ever store an API key in it (`chmod 600 ~/.config/luis/config.json`).

Precedence (highest first):
1. CLI flags
2. Shell environment variables (`LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, …)
3. `~/.config/luis/config.json`
4. Project `.env` (when `luis` is launched from the project root)
5. Built-in defaults

### Interactive mode

```bash
luis
```

Opens a REPL connected to the local LLM. Type natural language; press `Ctrl+C` or type `exit`/`quit` to leave.

```
luis v0.1.0
LLM provider: local. Type "exit" or press Ctrl+C to leave.

luis> hola
¡Hola! ¿En qué puedo ayudarte?
luis> exit
Bye.
```

### Non-interactive commands

| Command | What it does |
|---|---|
| `luis status` | Shows assistant name, uptime and module statuses. |
| `luis llm status` | Health-checks the local LLM provider. Exits 1 if unreachable. |
| `luis ask "<text>"` | Sends a one-shot prompt to the local LLM. |
| `luis downloads rules` | Lists configured download rules. |
| `luis downloads organize` | Placeholder until the downloads organizer service is wired. |
| `luis mail summary` | Placeholder — returns "Email integration is not implemented yet". |
| `luis calendar today` | Placeholder — returns "Calendar integration is not implemented yet". |
| `luis pg task PG-123` | Placeholder — returns "Planning Game integration is not implemented yet". |
| `luis code PG-123 --agent codex` | Blocked unless `ENABLE_REMOTE_CODE_TASKS=true`. |
| `luis help` | Lists every registered command. |

### CLI security policies

- The CLI never calls `child_process` directly — destructive actions must go through `approval-service`.
- The CLI never sends data to a cloud LLM unless `ALLOW_CLOUD_LLM=true` AND the request is explicitly marked non-private.
- `luis code …` is blocked by default (`ENABLE_REMOTE_CODE_TASKS=false`). Even when enabled, no agent runner is wired yet — the command is a placeholder.
- Errors are caught per turn: a single failed call never kills an interactive session.
- The user config file is read silently — a malformed JSON falls back to defaults instead of crashing.

### Quick check after configuring

```bash
luis llm status
```

### Current CLI limitations

- `luis downloads organize` is a placeholder until the watcher service is exposed as a one-shot job.
- `luis mail …`, `luis calendar …`, `luis pg …` are placeholders.
- `luis code …` does not run any agent yet, even when the feature flag is on.
- The interactive session is single-turn (no conversation memory yet).
- Only one LLM endpoint is supported at a time — no automatic failover between cluster nodes yet.

---

## Web UI

The assistant ships with a token-protected web dashboard you can reach from your phone or any
computer on the LAN. It calls the assistant's own HTTP API; the browser never talks to the LLM
directly. **Open WebUI is not used and is not needed** — the UI lives entirely inside this
project, sharing the same services as the CLI and the Telegram bot.

### Configuration

Add to `.env` (and to `.env.example`):

```env
WEB_ENABLED=true
WEB_HOST=0.0.0.0
WEB_PORT=3000
WEB_ACCESS_TOKEN=change-me-to-a-long-random-string
```

- `WEB_ENABLED` — must be `true` for the web app to start. Defaults to off.
- `WEB_HOST` — `0.0.0.0` to accept LAN connections; `127.0.0.1` to keep it local only.
- `WEB_PORT` — TCP port. Defaults to `3000`. Pick anything free.
- `WEB_ACCESS_TOKEN` — required. The server refuses to start with `WEB_ENABLED=true` and an empty token.

Generate a token quickly:

```bash
openssl rand -hex 32
```

### Accessing the UI

After `pnpm start`:

```text
Web app started — http://0.0.0.0:3000
```

From the same host: <http://localhost:3000>.

From any other device on your LAN:
1. Find the assistant host's IP: `hostname -I | awk '{print $1}'` on Linux.
2. Open `http://<host-ip>:3000` in any browser.
3. The UI prompts for `WEB_ACCESS_TOKEN` on first visit and stores it in the browser's
   `localStorage`. Click the `⎋` button in the header to forget it.

### Endpoints

All `/api/*` endpoints require the access token via:
- `Authorization: Bearer <token>` (preferred), or
- `x-access-token: <token>` header, or
- `?access_token=<token>` query parameter.

| Endpoint | Description |
|---|---|
| `GET /api/status` | Assistant name, uptime, modules. |
| `GET /api/llm/status` | Health of the local LLM provider. Returns 503 when unhealthy. |
| `POST /api/ask` | Body: `{ "prompt": "..." }`. Calls `llmService.generateText` with `module='web'`, `private=true`. |
| `GET /api/downloads/rules` | Lists configured download rules. |
| `POST /api/downloads/organize` | Placeholder until the organizer service is wired. |
| `GET /` | Serves the static UI from `src/apps/web/public/`. |

### Web security

- Cloud LLM is never reached: `POST /api/ask` flags the request as `private`, and `LlmService`
  refuses cloud providers when `ALLOW_CLOUD_LLM=false`.
- No `child_process`, no shell, no filesystem access from the web layer beyond serving the static
  UI files (the public directory is jailed against path traversal).
- `WEB_ACCESS_TOKEN` is compared in constant time to avoid timing oracles.
- `/api/downloads/organize` returns a placeholder — destructive moves still need approval and
  are not exposed to HTTP yet.

### Web limitations

- No multi-user accounts. One shared token. Run behind a tunnel (Tailscale, WireGuard) if you
  need to reach it from outside the LAN.
- Rate limits are not enforced.
- The UI is intentionally minimal: no markdown rendering, no streaming, no conversation history.

---

## Starting the assistant

```bash
pnpm start
```

The assistant will:
1. Load configuration from `.env`
2. Start the downloads watcher
3. Start the Telegram bot (if token configured)
4. Listen for commands

Stop with `Ctrl+C` or send `SIGTERM`.

---

## Security limitations

- Only Telegram chat IDs listed in `TELEGRAM_ALLOWED_CHAT_IDS` can interact with the bot
- Cloud LLM providers are disabled by default (`ALLOW_CLOUD_LLM=false`)
- Dangerous shell commands are blocked pending approval (approval UI not yet implemented)
- File moves are non-destructive: existing files are never overwritten
- No real coding agent execution in this version
- Do not expose the Telegram bot token or `.env` file

---

## Future roadmap

- [ ] Gmail API and Microsoft Graph email integration (read-only)
- [ ] Google Calendar and Microsoft Graph calendar integration (read-only)
- [ ] Planning Game API integration
- [ ] Coding agent execution (Codex, Claude, Gemini, Karajan)
- [ ] Telegram approval flow for dangerous actions
- [ ] Natural language command parsing via local LLM
- [ ] Desktop notification channel
- [ ] Slack notification channel
- [ ] Scheduled tasks (daily summaries, reminders)
- [ ] Web UI for configuration and approval
