# Assistant

A local Linux personal assistant that runs as a background service and acts as a private engineering and personal assistant.

The assistant is designed around a **local-first, privacy-first** principle: private data stays in your home network. Cloud LLM providers are disabled by default.

---

## What the first version includes

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
