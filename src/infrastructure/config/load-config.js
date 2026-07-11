import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Loads the .env file from the given path if it exists.
 * Skips silently if the file is missing (production may use real env vars).
 *
 * @param {string} [envPath='.env']
 */
function loadDotEnv(envPath = '.env') {
  const fullPath = resolve(process.cwd(), envPath);
  if (!existsSync(fullPath)) return;

  const content = readFileSync(fullPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    // Do not override values already set in the environment
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Parses a comma-separated list of IDs into an array.
 *
 * @param {string | undefined} raw
 * @returns {string[]}
 */
function parseCsvList(raw) {
  if (!raw) return [];
  return raw.split(',').map((id) => id.trim()).filter(Boolean);
}

/**
 * Parses a comma-separated list of integers, falling back to `fallback` when
 * empty, unset or fully invalid.
 *
 * @param {string | undefined} raw
 * @param {number[]} fallback
 * @returns {number[]}
 */
function parseCsvNumbers(raw, fallback) {
  const list = parseCsvList(raw).map(Number).filter((n) => Number.isInteger(n));
  return list.length > 0 ? list : fallback;
}

/**
 * Loads and validates all configuration from environment variables.
 * Must be called once at startup after dotenv is loaded.
 *
 * @param {string} [envPath='.env']
 * @returns {AssistantConfig}
 */
export function loadConfig(envPath = '.env') {
  loadDotEnv(envPath);

  const config = {
    env: process.env.NODE_ENV ?? 'development',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    assistantName: process.env.ASSISTANT_NAME ?? 'assistant',

    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
      allowedChatIds: parseCsvList(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
      // Chat that receives unsolicited notifications (cluster alerts, etc.).
      // Falls back to the first allowed chat when not set explicitly.
      notifyChatId: process.env.TELEGRAM_NOTIFY_CHAT_ID ?? '',
    },

    watchtower: {
      // Shared secret for the POST /api/hooks/watchtower webhook.
      // Empty disables the endpoint (503).
      webhookToken: process.env.WATCHTOWER_WEBHOOK_TOKEN ?? '',
    },

    aptHealth: {
      // Shared secret for the POST /api/hooks/apt-health webhook.
      // Empty disables the endpoint (503).
      webhookToken: process.env.APT_HEALTH_WEBHOOK_TOKEN ?? '',
    },

    cluster: {
      enabled: process.env.CLUSTER_ENABLED !== 'false',
      // No hardcoded LAN: the node IPs are deployment-specific and must be
      // provided when the watcher is enabled (validated below).
      n2Ip: process.env.CLUSTER_N2_IP ?? '',
      n3Ip: process.env.CLUSTER_N3_IP ?? '',
      n4Ip: process.env.CLUSTER_N4_IP ?? '',
      historyPath:
        process.env.CLUSTER_HISTORY_PATH ?? join(homedir(), '.config', 'luis', 'cluster-history.json'),
      // LUI-TSK-0067: franja silenciosa diaria. Cualquier down que ocurra
      // dentro de la franja se posterga: si el servicio sigue caído al
      // salir de la franja, entonces se notifica. Si se recupera dentro de
      // la franja, ni se notifica ni se logea como incidente al usuario.
      // Formato HH:MM 24h. Vacío = comportamiento clásico (sin filtro).
      quietWindowStart: process.env.CLUSTER_QUIET_START ?? '',
      quietWindowEnd: process.env.CLUSTER_QUIET_END ?? '',
    },

    prometheus: {
      // On-demand "is anything down?" checks against the Prometheus HTTP API.
      // No watcher, no proactive alerts — only answered when the user asks.
      // Opt-in (like the cluster watcher): set PROMETHEUS_ENABLED=true.
      enabled: process.env.PROMETHEUS_ENABLED === 'true',
      // Deployment-specific: Prometheus is reached over the LAN (validated below).
      baseUrl: process.env.PROMETHEUS_BASE_URL ?? '',
      timeoutMs: Number(process.env.PROMETHEUS_TIMEOUT_MS ?? 8000),
    },

    media: {
      // Límites para /transcribe (vídeo/audio local subido por Telegram o
      // pasado por la CLI). El tope superior depende mucho del Whisper
      // backend; los defaults asumen CPU pequeña (~30 min audio = 500 MB
      // sería excesivo, pero damos margen para vídeo crudo).
      maxBytes: Number(process.env.MEDIA_LOCAL_MAX_BYTES ?? 500 * 1024 * 1024),
      maxDurationSec: Number(process.env.MEDIA_LOCAL_MAX_DURATION_S ?? 4 * 60 * 60),
    },

    downloads: {
      watchPath: process.env.DOWNLOADS_PATH ?? '/tmp/downloads',
      rulesPath: process.env.DOWNLOAD_RULES_PATH ?? './config/download-rules.json',
      enableLlmClassification: process.env.ENABLE_LLM_FILE_CLASSIFICATION === 'true',
    },

    inbox: {
      path: process.env.INBOX_PATH ?? '/data/inbox',
      notesPath: process.env.INBOX_NOTES_PATH ?? '/data/notes',
      // Markitdown sidecar (TSK-0051). Optional: if empty, doc/estudio just
      // stay pending without text extraction (graceful fallback).
      markitdownUrl: process.env.MARKITDOWN_URL ?? '',
      markitdownTimeoutMs: Number(process.env.MARKITDOWN_TIMEOUT_MS ?? 60000),
      // Model override for /resumir AND the router classification. The default
      // LLM model ("fast") returns empty content on the local cluster for both
      // prompts — same bug. Override with a model that handles Spanish text
      // (verified: "coder" works). Empty string = use the default.
      classifyModel: process.env.INBOX_CLASSIFY_MODEL ?? 'coder',
      summariseModel: process.env.INBOX_SUMMARISE_MODEL ?? 'coder',
      // Idioma destino del resumen, independiente del idioma del texto fuente.
      // Si el artículo está en inglés y este es 'es', el LLM lo resume en español.
      summaryLanguage: process.env.INBOX_SUMMARY_LANGUAGE ?? 'es',
      // Umbral en caracteres para activar chunking del resumen. Textos por encima
      // de este límite se trocean y se resumen en pasos en lugar de truncarse.
      summaryChunkChars: Number(process.env.INBOX_SUMMARY_CHUNK_CHARS ?? 8000),
      // Drive folder ID where the processor uploads documents/photos/studies
      // when they finish (TSK-0049). Empty string = Drive upload disabled.
      driveFolderId: process.env.DRIVE_INBOX_FOLDER_ID ?? '',
    },

    llm: {
      provider: process.env.LLM_PROVIDER ?? 'local',
      allowCloudLlm: process.env.ALLOW_CLOUD_LLM === 'true',
      local: {
        baseUrl: process.env.LOCAL_LLM_BASE_URL ?? 'http://localhost:11434',
        // Backup opcional (LUI-TSK-0010). Si está, el provider intenta el
        // primario y, si falla o health check no responde en 5s, usa el
        // backup. Cuando el primario vuelva, próxima petición lo usa.
        backupUrl: process.env.LOCAL_LLM_BACKUP_URL ?? '',
        model: process.env.LOCAL_LLM_MODEL ?? '',
        apiKey: process.env.LOCAL_LLM_API_KEY ?? '',
        timeoutMs: Number(process.env.LOCAL_LLM_TIMEOUT_MS ?? 120000),
      },
      cloud: {
        provider: process.env.CLOUD_LLM_PROVIDER ?? '',
        apiKey: process.env.CLOUD_LLM_API_KEY ?? '',
      },
    },

    whisper: {
      baseUrl: process.env.WHISPER_BASE_URL ?? '',
      model: process.env.WHISPER_MODEL ?? 'whisper-1',
      apiKey: process.env.WHISPER_API_KEY ?? '',
      timeoutMs: Number(process.env.WHISPER_TIMEOUT_MS ?? 600000),
    },

    youtube: {
      ytdlpBin: process.env.YOUTUBE_YTDLP_BIN ?? 'yt-dlp',
      defaultLanguage: process.env.YOUTUBE_DEFAULT_LANGUAGE ?? 'es',
      summaryChunkChars: Number(process.env.YOUTUBE_SUMMARY_CHUNK_CHARS ?? 8000),
      subtitleTimeoutMs: Number(process.env.YOUTUBE_SUBTITLE_TIMEOUT_MS ?? 60000),
      audioTimeoutMs: Number(process.env.YOUTUBE_AUDIO_TIMEOUT_MS ?? 600000),
    },

    email: {
      provider: process.env.EMAIL_PROVIDER ?? 'disabled',
      readOnly: process.env.EMAIL_READ_ONLY !== 'false',
    },

    calendar: {
      provider: process.env.CALENDAR_PROVIDER ?? 'disabled',
      readOnly: process.env.CALENDAR_READ_ONLY !== 'false',
    },

    google: {
      credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH ?? '',
      tokensPath: process.env.GOOGLE_TOKENS_PATH ?? '',
    },

    gmailDigest: {
      // Diario de correos "estudio" → Telegram (LUI-TSK-0031). Off por defecto.
      enabled: process.env.GMAIL_DIGEST_ENABLED === 'true',
      // Query Gmail. Por defecto: no-leídos con label "Estudio".
      query: process.env.GMAIL_DIGEST_QUERY ?? 'is:unread label:Estudio',
      // Hora local de envío (HH:MM). Aleatorio dentro de la ventana ±5 min
      // para evitar coincidencias exactas si el proceso rearranca.
      hour: Number(process.env.GMAIL_DIGEST_HOUR ?? 8),
      minute: Number(process.env.GMAIL_DIGEST_MINUTE ?? 30),
      // Máx correos a incluir por digest. Más de eso = top-N por fecha y aviso.
      maxResults: Number(process.env.GMAIL_DIGEST_MAX ?? 20),
      // Si true, tras enviar el digest marca los correos como leídos.
      markAsRead: process.env.GMAIL_DIGEST_MARK_READ !== 'false',
      // LUI-TSK-0063: dos canales independientes por etiqueta. La config
      // del store en disco anula estos defaults si existe.
      listLabels: parseCsvList(process.env.GMAIL_DIGEST_LIST_LABELS),
      summaryLabels: parseCsvList(process.env.GMAIL_DIGEST_SUMMARY_LABELS),
      // Directorio donde el digest persiste su estado: config, last-run
      // por etiqueta, y resúmenes pre-generados. /data en el container.
      cachePath: process.env.GMAIL_DIGEST_CACHE_PATH ?? '/data/digest-cache',
    },

    planningGame: {
      baseUrl: process.env.PLANNING_GAME_BASE_URL ?? '',
      apiKey: process.env.PLANNING_GAME_API_KEY ?? '',
    },

    codeAgents: {
      workspacesPath: process.env.CODE_WORKSPACES_PATH ?? '/tmp/ai-workspaces',
      enableRemoteCodeTasks: process.env.ENABLE_REMOTE_CODE_TASKS === 'true',
      requireApproval: process.env.REQUIRE_APPROVAL_FOR_CODE_TASKS !== 'false',
    },

    web: {
      enabled: process.env.WEB_ENABLED === 'true',
      host: process.env.WEB_HOST ?? '0.0.0.0',
      port: Number(process.env.WEB_PORT ?? 3000),
    },

    webTools: {
      search: {
        baseUrl: process.env.WEB_SEARCH_BASE_URL ?? '',
        apiKey: process.env.WEB_SEARCH_API_KEY ?? '',
      },
      urlFetch: {
        allowPrivateNetworks: process.env.URL_FETCH_ALLOW_PRIVATE === 'true',
        privateAllowlist: (process.env.URL_FETCH_ALLOWLIST ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
      },
    },

    homeAssistant: {
      baseUrl: process.env.HA_BASE_URL ?? '',
      token: process.env.HA_TOKEN ?? '',
      language: process.env.HA_LANGUAGE ?? 'es',
      agentId: process.env.HA_AGENT_ID ?? '',
    },

    temperature: {
      // Watcher de temperatura vía Home Assistant (LUI-TSK-0071). Off por
      // defecto; al habilitarlo requiere HA configurado (validado abajo).
      enabled: process.env.TEMP_WATCHER_ENABLED === 'true',
      checkIntervalMs: Number(process.env.TEMP_CHECK_INTERVAL_MS ?? 15 * 60 * 1000),
      // Temporadas por número de mes (1-12).
      summerMonths: parseCsvNumbers(process.env.TEMP_SUMMER_MONTHS, [5, 6, 7, 8, 9, 10]),
      winterMonths: parseCsvNumbers(process.env.TEMP_WINTER_MONTHS, [11, 12, 1, 2, 3, 4]),
      // Verano (calor): alerta si media de la casa ≥ mean o alguna habitación ≥ room.
      summerMeanThreshold: Number(process.env.TEMP_SUMMER_MEAN_MAX ?? 30.0),
      summerRoomThreshold: Number(process.env.TEMP_SUMMER_ROOM_MAX ?? 31.0),
      // Invierno (frío): alerta si media ≤ mean o alguna habitación ≤ room.
      winterMeanThreshold: Number(process.env.TEMP_WINTER_MEAN_MIN ?? 20.1),
      winterRoomThreshold: Number(process.env.TEMP_WINTER_ROOM_MIN ?? 20.1),
      // Re-aviso si la alerta persiste (ms). Default 3 h.
      reAlertMs: Number(process.env.TEMP_REALERT_MS ?? 3 * 60 * 60 * 1000),
      // Regex (case-insensitive) para excluir sensores no interiores de la media
      // y la vigilancia (exterior, nevera, dispositivos…). Vacío = ninguno.
      excludePattern: process.env.TEMP_EXCLUDE_PATTERN
        ?? 'exterior|outdoor|fuera|terraza|jard[ií]n|calle|balc[oó]n|nevera|frigo|congelador|fridge|freezer|cpu|bater|battery|coche|\\bext\\b',
      // Sólo cuenta sensores con habitación (area) asignada: descarta duplicados
      // y dispositivos sin área con valores basura (p.ej. 0.0). Pon
      // TEMP_REQUIRE_AREA=false para incluir también los sensores sin área.
      requireArea: process.env.TEMP_REQUIRE_AREA !== 'false',
      // Sensor de temperatura EXTERIOR (entity_id). Se lee para incluirlo en el
      // aviso y se excluye de la media/habitaciones interiores. Vacío = sin
      // exterior. Específico del despliegue: configúralo por env.
      outdoorEntity: process.env.TEMP_OUTDOOR_ENTITY ?? '',
      // Franja silenciosa nocturna (HH:MM). Default 23:00-08:00.
      quietWindowStart: process.env.TEMP_QUIET_START ?? '23:00',
      quietWindowEnd: process.env.TEMP_QUIET_END ?? '08:00',
    },
  };

  validateConfig(config);
  return config;
}

/**
 * Fails fast on configuration that would otherwise break or silently misbehave
 * at runtime. Keep messages actionable (tell the user exactly what to set).
 *
 * @param {AssistantConfig} config
 */
function validateConfig(config) {
  if (config.cluster.enabled) {
    const missing = ['n2Ip', 'n3Ip', 'n4Ip']
      .filter((key) => !config.cluster[key])
      .map((key) => `CLUSTER_${key.replace('Ip', '').toUpperCase()}_IP`);
    if (missing.length > 0) {
      throw new Error(
        `Cluster watcher is enabled but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
          'Set them in your .env (see DEPLOYMENT.md) or set CLUSTER_ENABLED=false to disable the watcher.',
      );
    }
  }

  if (config.prometheus.enabled && !config.prometheus.baseUrl) {
    throw new Error(
      'Prometheus integration is enabled but PROMETHEUS_BASE_URL is not set. ' +
        'Set it (e.g. http://192.168.1.7:9090) or set PROMETHEUS_ENABLED=false to disable it.',
    );
  }

  if (config.temperature.enabled && (!config.homeAssistant.baseUrl || !config.homeAssistant.token)) {
    throw new Error(
      'Temperature watcher is enabled (TEMP_WATCHER_ENABLED=true) but Home Assistant is not configured. ' +
        'Set HA_BASE_URL and HA_TOKEN, or set TEMP_WATCHER_ENABLED=false to disable it.',
    );
  }
}

/**
 * @typedef {Object} AssistantConfig
 * @property {string} env
 * @property {string} logLevel
 * @property {string} assistantName
 * @property {{ botToken: string, allowedChatIds: string[], notifyChatId: string }} telegram
 * @property {{ webhookToken: string }} watchtower
 * @property {{ enabled: boolean, n2Ip: string, n3Ip: string, n4Ip: string, historyPath: string }} cluster
 * @property {{ enabled: boolean, baseUrl: string, timeoutMs: number }} prometheus
 * @property {{ watchPath: string, rulesPath: string, enableLlmClassification: boolean }} downloads
 * @property {{ path: string, notesPath: string, markitdownUrl: string, markitdownTimeoutMs: number, classifyModel: string, summariseModel: string, driveFolderId: string }} inbox
 * @property {import('../../types/llm.js').LlmConfig} llm
 * @property {{ provider: string, readOnly: boolean }} email
 * @property {{ provider: string, readOnly: boolean }} calendar
 * @property {{ baseUrl: string, apiKey: string }} planningGame
 * @property {{ workspacesPath: string, enableRemoteCodeTasks: boolean, requireApproval: boolean }} codeAgents
 * @property {{ enabled: boolean, host: string, port: number }} web
 * @property {{ search: { baseUrl: string, apiKey: string }, urlFetch: { allowPrivateNetworks: boolean, privateAllowlist: string[] } }} webTools
 * @property {{ baseUrl: string, token: string, language: string, agentId: string }} homeAssistant
 * @property {{ enabled: boolean, checkIntervalMs: number, summerMonths: number[], winterMonths: number[], summerMeanThreshold: number, summerRoomThreshold: number, winterMeanThreshold: number, winterRoomThreshold: number, reAlertMs: number, excludePattern: string, requireArea: boolean, outdoorEntity: string, quietWindowStart: string, quietWindowEnd: string }} temperature
 * @property {{ credentialsPath: string, tokensPath: string }} google
 */
