# SPEC.md: Linux Personal Assistant Orchestrator

## 1. Goal

Build a local Linux assistant that runs as a background service and acts as a private personal and engineering assistant.

The assistant must:

- Read email in read-only mode.
- Summarize relevant emails.
- Watch the Downloads folder and organize files according to configurable rules.
- Read calendar events and send reminders.
- Integrate with Telegram as the main remote interface.
- Use a local LLM running in a two-miniPC home cluster as the default reasoning provider.
- Trigger remote coding workflows using Planning Game, Karajan, Codex, Claude, or Gemini.
- Keep private information local by default.
- Never perform destructive or irreversible actions without explicit approval.

The assistant must not be designed as a Codex-only tool.

Codex, Claude, Gemini and Karajan are coding workers. The central piece is the local Linux assistant orchestrator.

---

## 2. Architectural Principles

- The assistant runs locally on Linux.
- The assistant is modular.
- The assistant uses dependency injection where practical.
- Domain logic must not depend directly on Telegram, filesystem, vendor APIs, or shell commands.
- Integrations must be implemented as adapters.
- The local LLM provider is the default provider.
- Cloud LLM providers are disabled by default.
- Sensitive data must not leave the local network unless explicitly enabled.
- Coding agents must run in isolated workspaces.
- Human approval is required before commits, pushes, PRs, deletes, or dangerous commands.

---

## 3. Technology Constraints

- Use Node.js with pnpm.
- Use vanilla JavaScript.
- Do not use TypeScript.
- Use JSDoc comments in English.
- Use `.d.ts` files for type checking.
- Use ES2020 or newer.
- Use native Node.js APIs where reasonable.
- Prefer small, single-responsibility functions.
- Prefer descriptive names for variables, functions, methods and classes.
- Keep modules decoupled.
- Use dependency injection for infrastructure dependencies.
- Add unit tests for all core logic.

---

## 4. Runtime Context

The assistant is expected to run on a Linux machine inside the user's home network.

The user also has a local LLM running in a cluster of two miniPCs in the same network.

The assistant must access that model through an HTTP API.

The first version must assume an OpenAI-compatible local endpoint, but the provider must be abstract enough to support other local runtimes later.

Examples of possible local runtimes:

- Ollama
- llama.cpp server
- vLLM
- LM Studio server
- Custom OpenAI-compatible endpoint

No specific runtime must be hardcoded.

---

## 5. Initial Scope

Build the project skeleton and implement the first vertical slice:

1. Telegram bot receives commands.
2. Authorized Telegram chat IDs are validated.
3. `/status` returns assistant status.
4. `/downloads-rules` lists configured download rules.
5. `/llm-status` checks the local LLM provider.
6. Downloads watcher detects new files.
7. Files are classified by extension using configurable rules.
8. Unknown files can optionally be classified by the local LLM.
9. Matching files are moved to target folders.
10. Every action is logged.
11. Email, calendar, Planning Game and coding-agent integrations are created only as interfaces/placeholders.
12. No real email/calendar/coding-agent calls are implemented in the first slice.

---

## 6. Project Structure

Create this structure:

```text
assistant/
  package.json
  pnpm-lock.yaml
  .env.example
  README.md
  SPEC.md
  config/
    download-rules.example.json
  src/
    main.js

    apps/
      telegram-bot/
        create-telegram-bot.js
        telegram-command-router.js
        telegram-message-handler.js

    modules/
      assistant/
        assistant-status-service.js

      llm/
        llm-service.js
        local-llm-provider.js
        cloud-llm-provider.js
        llm-provider-factory.js

      downloads/
        download-watcher.js
        file-classifier.js
        file-mover.js
        download-rules-repository.js
        llm-file-classifier.js

      email/
        email-client.js
        email-summary-service.js
        email-classifier.js

      calendar/
        calendar-client.js
        calendar-summary-service.js
        calendar-reminder-service.js

      planning-game/
        planning-game-client.js
        planning-game-task-service.js

      code-agents/
        code-agent.js
        codex-agent.js
        claude-agent.js
        gemini-agent.js
        karajan-agent.js
        code-task-orchestrator.js
        workspace-service.js

      notifications/
        notification-service.js
        telegram-notification-channel.js

      security/
        approval-service.js
        command-policy.js
        allowed-chat-policy.js
        dangerous-command-detector.js

    infrastructure/
      config/
        load-config.js
      logger/
        create-logger.js
      shell/
        shell-command-runner.js
      scheduler/
        scheduler.js
      http/
        create-http-client.js
      filesystem/
        file-system.js

  test/
    modules/
      llm/
        local-llm-provider.test.js
        llm-service.test.js
      downloads/
        file-classifier.test.js
        file-mover.test.js
        llm-file-classifier.test.js
      security/
        allowed-chat-policy.test.js
        dangerous-command-detector.test.js
      apps/
        telegram-bot/
          telegram-command-router.test.js

  types/
    llm.d.ts
    downloads.d.ts
    code-agents.d.ts
    email.d.ts
    calendar.d.ts
```

---

## 7. Environment Variables

Create `.env.example`:

```env
NODE_ENV=development
LOG_LEVEL=info

ASSISTANT_NAME=karajan-assistant

TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_IDS=

DOWNLOADS_PATH=/home/manu/Descargas
DOWNLOAD_RULES_PATH=./config/download-rules.json
ENABLE_LLM_FILE_CLASSIFICATION=false

LLM_PROVIDER=local
LOCAL_LLM_BASE_URL=http://192.168.1.10:11434
LOCAL_LLM_MODEL=
LOCAL_LLM_API_KEY=
LOCAL_LLM_TIMEOUT_MS=120000

ALLOW_CLOUD_LLM=false
CLOUD_LLM_PROVIDER=
CLOUD_LLM_API_KEY=

EMAIL_PROVIDER=disabled
EMAIL_READ_ONLY=true

CALENDAR_PROVIDER=disabled
CALENDAR_READ_ONLY=true

PLANNING_GAME_BASE_URL=
PLANNING_GAME_API_KEY=

CODE_WORKSPACES_PATH=/home/manu/ai-workspaces
ENABLE_REMOTE_CODE_TASKS=false
REQUIRE_APPROVAL_FOR_CODE_TASKS=true
```

---

## 8. Local LLM Provider

The assistant must support a local LLM provider running inside the user's home network.

The local LLM provider must be the default provider.

The local model may run in a cluster of two miniPCs and must be accessed through an HTTP API.

The first implementation should support an OpenAI-compatible API shape where possible.

The assistant must not depend directly on OpenAI, Claude, Gemini, or any cloud provider for general reasoning tasks.

Create these files:

```text
src/modules/llm/llm-service.js
src/modules/llm/local-llm-provider.js
src/modules/llm/cloud-llm-provider.js
src/modules/llm/llm-provider-factory.js
types/llm.d.ts
```

The local LLM provider must expose this interface:

```js
/**
 * Generates text using the configured language model.
 *
 * @param {LlmPromptRequest} llmPromptRequest
 * @returns {Promise<LlmPromptResponse>}
 */
async function generateText(llmPromptRequest) {}
```

The LLM service must be used for:

- Email summaries.
- File classification when rule-based classification is not enough.
- Calendar summaries.
- Natural language Telegram commands.
- Planning Game task summarization.
- Preparation of coding-agent context.

The assistant must not send private email, calendar, filesystem, or project content to cloud providers unless explicitly enabled.

Default behavior:

```env
ALLOW_CLOUD_LLM=false
```

If `ALLOW_CLOUD_LLM=false`, only the local LLM provider may be used.

---

## 9. LLM Request Privacy

Every LLM request must include metadata:

- module
- operation
- timestamp
- model
- provider
- correlation id

Logs must not include full prompt content by default.

Allowed default log:

```json
{
  "module": "email",
  "operation": "summarize",
  "provider": "local",
  "model": "configured-model",
  "promptLength": 1200,
  "correlationId": "..."
}
```

Disallowed default log:

```json
{
  "prompt": "Full private email content..."
}
```

Full prompt logging may only be enabled explicitly with a debug flag in future versions.

Do not implement full prompt logging in the first version.

---

## 10. Download Rules

Create an example config file at `config/download-rules.example.json`:

```json
{
  "rules": [
    {
      "name": "PDF documents",
      "extensions": [".pdf"],
      "targetPath": "/home/manu/Documentos/PDF"
    },
    {
      "name": "Compressed files",
      "extensions": [".zip", ".tar", ".gz", ".7z"],
      "targetPath": "/home/manu/Descargas/Comprimidos"
    },
    {
      "name": "Images",
      "extensions": [".jpg", ".jpeg", ".png", ".webp"],
      "targetPath": "/home/manu/Imágenes/Entrantes"
    },
    {
      "name": "STL files",
      "extensions": [".stl"],
      "targetPath": "/home/manu/Documentos/STL"
    },
    {
      "name": "Spreadsheets",
      "extensions": [".csv", ".xls", ".xlsx", ".ods"],
      "targetPath": "/home/manu/Documentos/HojasCalculo"
    }
  ]
}
```

Rule-based classification must be attempted first.

LLM-based classification must only run when:

- no rule matches,
- `ENABLE_LLM_FILE_CLASSIFICATION=true`,
- the file is not too large,
- the file type is allowed for inspection.

The first version may classify unknown files only by filename and extension, not by reading full content.

---

## 11. Telegram Interface

Implement these initial commands:

```text
/status
/downloads-rules
/llm-status
/help
```

Expected behavior:

- `/status`: returns assistant name, uptime, enabled modules and environment.
- `/downloads-rules`: returns the current configured file movement rules.
- `/llm-status`: checks whether the local LLM provider is reachable.
- `/help`: returns the available commands.

Telegram commands must only work for allowed chat IDs.

Unauthorized chat IDs must be rejected and logged without exposing sensitive information.

Natural language commands are out of scope for the first slice, but the architecture must allow adding them later using the local LLM provider.

---

## 12. Email Integration

Email is out of scope for the first implementation, but the architecture must include interfaces.

The email module must be designed for read-only access.

Supported future providers:

- Gmail API
- Microsoft Graph

Email module responsibilities:

- Fetch unread emails.
- Fetch important emails.
- Fetch emails by query.
- Summarize email batches using the local LLM.
- Detect emails that require attention.
- Notify via Telegram.

Email module must not:

- send emails,
- delete emails,
- archive emails,
- label emails,
- mark emails as read,

unless explicitly implemented in a future version with separate permissions.

Initial environment:

```env
EMAIL_PROVIDER=disabled
EMAIL_READ_ONLY=true
```

---

## 13. Calendar Integration

Calendar is out of scope for the first implementation, but the architecture must include interfaces.

Supported future providers:

- Google Calendar
- Microsoft Graph Calendar

Calendar module responsibilities:

- Read today's events.
- Read upcoming events.
- Summarize the day.
- Send reminders through Telegram.
- Detect event changes.

Calendar module must be read-only in the initial versions.

Initial environment:

```env
CALENDAR_PROVIDER=disabled
CALENDAR_READ_ONLY=true
```

---

## 14. Planning Game Integration

Planning Game is out of scope for the first implementation, but the architecture must include interfaces.

Future responsibilities:

- Read task by ID.
- Read sprint tasks.
- Read task context.
- Update task status only after explicit approval.
- Send task context to code-task orchestrator.
- Summarize task using the local LLM.

No real Planning Game API call must be implemented in the first slice.

---

## 15. Coding Agents

Coding agents are workers, not the main assistant.

Supported future agents:

- Codex CLI
- Claude CLI
- Gemini CLI
- Karajan

All coding agents must expose the same interface:

```js
/**
 * Runs a coding task using a specific AI coding agent.
 *
 * @param {CodeTaskContext} codeTaskContext
 * @returns {Promise<CodeTaskResult>}
 */
async function runCodeTask(codeTaskContext) {}
```

The code-task orchestrator must eventually support this workflow:

1. Receive approved coding request from Telegram.
2. Fetch task context from Planning Game.
3. Create isolated workspace.
4. Clone or prepare repository.
5. Create branch.
6. Generate implementation plan.
7. Run selected coding agent.
8. Run tests.
9. Produce summary.
10. Ask for approval before commit/push/PR.
11. Commit only after approval.
12. Push only after approval.
13. Open PR only after approval.

The first implementation must only create placeholders and interfaces.

---

## 16. Remote Coding Security

Remote coding from Telegram is powerful and dangerous.

Default state:

```env
ENABLE_REMOTE_CODE_TASKS=false
REQUIRE_APPROVAL_FOR_CODE_TASKS=true
```

The assistant must never run coding tasks automatically from arbitrary Telegram text.

Dangerous commands must be detected and blocked unless explicitly approved in a future version.

Examples of dangerous commands:

```text
rm -rf
sudo
mkfs
dd
chmod -R 777
chown -R
docker system prune
git push --force
```

Shell execution must only happen through:

```text
src/infrastructure/shell/shell-command-runner.js
```

No module may call `child_process` directly.

---

## 17. Approval Service

Create an approval service interface.

The approval service will later support:

- Telegram approval.
- CLI approval.
- Web UI approval.

Initial version:

- Implement a placeholder.
- Any destructive action must return "approval required".
- No destructive action is actually executed.

Actions requiring approval:

- delete files,
- overwrite files,
- execute shell commands,
- create commits,
- push branches,
- open PRs,
- change Planning Game task status,
- call cloud LLM providers,
- send private data outside local network.

---

## 18. Notifications

Notification service must abstract notification channels.

Initial channel:

- Telegram

Future channels:

- desktop notifications
- email
- Slack
- Teams

Notification service interface:

```js
/**
 * Sends a notification through the configured channels.
 *
 * @param {NotificationMessage} notificationMessage
 * @returns {Promise<void>}
 */
async function sendNotification(notificationMessage) {}
```

---

## 19. Testing Requirements

Use Node.js test runner or Vitest.

Add tests for:

### LLM

- Local LLM provider builds the expected request.
- Local LLM provider handles timeout.
- LLM service rejects cloud provider when `ALLOW_CLOUD_LLM=false`.
- LLM service delegates to local provider by default.

### Downloads

- File classification by extension.
- Unknown extension returns no rule.
- LLM file classification is not called when disabled.
- LLM file classification is called when enabled and no rule matches.
- File mover receives correct source and target.
- File mover does not overwrite existing files silently.

### Telegram

- Command router maps known commands.
- Command router rejects unknown commands.
- Command router rejects unauthorized chat IDs.
- `/llm-status` calls the LLM health check.

### Security

- Dangerous command detector blocks dangerous commands.
- Shell command runner is the only allowed execution path.
- Approval service blocks destructive actions by default.

---

## 20. Acceptance Criteria

The first task is complete when:

- `pnpm install` works.
- `pnpm test` works.
- `pnpm start` starts the assistant.
- `/status` works from Telegram.
- `/downloads-rules` works from Telegram.
- `/llm-status` checks the local LLM provider.
- Unauthorized Telegram chat IDs are rejected.
- Download rules can be loaded from JSON.
- File classification is covered by tests.
- Local LLM provider abstraction exists.
- Cloud LLM providers are disabled by default.
- No real email/calendar/Planning Game/coding-agent call is implemented yet.
- README explains how to configure and run the assistant.

---

## 21. README Requirements

README must explain:

- What the assistant does.
- What the first version includes.
- What is intentionally not implemented yet.
- How to install dependencies.
- How to configure `.env`.
- How to create the Telegram bot.
- How to obtain the Telegram chat ID.
- How to configure the downloads path.
- How to configure the local LLM provider.
- How to run tests.
- How to start the assistant.
- Security limitations.
- Future roadmap.

---

## 22. Deliverables

- Working project skeleton.
- Unit tests.
- README.
- `.env.example`.
- Example download rules config.
- Local LLM provider abstraction.
- Telegram first commands.
- Download watcher and classifier.
- Security placeholders.
- Coding-agent placeholders.

---

## 23. Prompt for Codex

Use this prompt after saving this file as `SPEC.md`:

```text
You are working on a new local Linux personal assistant project.

Implement the project described in SPEC.md.

Important constraints:

- Use Node.js with pnpm.
- Use vanilla JavaScript only.
- Do not use TypeScript.
- Use JSDoc comments in English.
- Add .d.ts files for type checking.
- Use ES2020 or newer.
- Keep functions small and single-purpose.
- Use dependency injection where practical.
- Keep infrastructure code separated from domain logic.
- Add unit tests for the implemented logic.
- The local LLM provider is the default reasoning provider.
- Cloud LLM providers must be disabled by default.
- Private data must not be sent to cloud providers.
- Do not implement real email, calendar, Planning Game, Codex, Claude, Gemini, or Karajan integrations yet.
- Only create interfaces/placeholders for those modules.
- Implement the first vertical slice:
  - Telegram /status
  - Telegram /downloads-rules
  - Telegram /llm-status
  - Telegram /help
  - authorized Telegram chat validation
  - download rules loading
  - rule-based file classification
  - optional local-LLM file classification placeholder
  - filesystem watcher
  - file mover
  - local LLM provider abstraction
  - LLM health check
  - logging
  - security placeholders
  - unit tests

Work test-first where possible.

After implementation:

1. Run the tests.
2. Fix any failing tests.
3. Run lint/type checks if configured.
4. Update README with setup instructions.
5. Provide a final summary with:
   - files created,
   - commands to run,
   - tests status,
   - pending next steps.
```
