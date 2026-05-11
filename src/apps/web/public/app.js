/**
 * luis — frontend conversacional.
 *
 * Habla siempre con la API HTTP del asistente; nunca con el LLM directamente. Pensado para
 * red local de confianza: la API no pide autenticación. El historial vive en memoria del
 * navegador y se envía completo en cada `POST /api/chat` para que el modelo razone con el
 * contexto acumulado de turnos previos y de slash commands.
 */

const SYSTEM_PROMPT =
  'Eres luis, un asistente local. Responde con precisión y brevedad. ' +
  'El usuario puede darte contexto vía /fetch (URLs descargadas) y /search (resultados de búsqueda); ' +
  'razona sobre ese contexto cuando contestes. Si no sabes algo, dilo.';

const els = {
  statusDot: document.getElementById('status-dot'),
  assistantUptime: document.getElementById('assistant-uptime'),
  llmProvider: document.getElementById('llm-provider'),
  llmModel: document.getElementById('llm-model'),
  llmEndpoint: document.getElementById('llm-endpoint'),
  llmHealth: document.getElementById('llm-health'),
  modulesList: document.getElementById('modules-list'),
  rulesList: document.getElementById('rules-list'),
  conversation: document.getElementById('conversation'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  chatSubmit: document.getElementById('chat-submit'),
  chatStatus: document.getElementById('chat-status'),
  refreshBtn: document.getElementById('refresh-btn'),
  resetBtn: document.getElementById('reset-btn'),
};

/** @type {Array<{ role: 'system'|'user'|'assistant', content: string }>} */
const conversation = [{ role: 'system', content: SYSTEM_PROMPT }];

/** @type {{ haConversationId: string | null }} */
const sessionState = { haConversationId: null };

/**
 * Llama a la API HTTP del asistente.
 *
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<any>}
 */
async function apiCall(path, options = {}) {
  const init = {
    method: options.method ?? 'GET',
    headers: { Accept: 'application/json' },
  };

  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(path, init);
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }

  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'error' in payload
      ? `${payload.error}${payload.detail ? ` — ${payload.detail}` : ''}`
      : `HTTP ${response.status}`;
    throw new Error(detail);
  }

  return payload;
}

/**
 * Pinta el estado del asistente en la cabecera.
 *
 * @returns {Promise<void>}
 */
async function refreshStatus() {
  try {
    const status = await apiCall('/api/status');
    els.assistantUptime.textContent = `arriba ${status.uptimeFormatted}`;
    renderModules(status.modules ?? []);
    setOverallDot('ok');
  } catch (error) {
    setOverallDot('err');
    els.assistantUptime.textContent = '(desconectado)';
    showChatStatus(`Error de estado: ${error.message}`, true);
  }
}

/**
 * Comprueba la salud del proveedor LLM y la pinta.
 *
 * @returns {Promise<void>}
 */
async function refreshLlmStatus() {
  try {
    const health = await apiCall('/api/llm/status');
    els.llmProvider.textContent = health.provider ?? '—';
    els.llmModel.textContent = health.model || '(sin configurar)';
    els.llmEndpoint.textContent = health.baseUrl ?? '—';
    els.llmHealth.textContent = health.healthy ? '✓ accesible' : '✗ no accesible';
    els.llmHealth.style.color = health.healthy ? 'var(--ok)' : 'var(--err)';
  } catch (error) {
    els.llmHealth.textContent = `✗ ${error.message}`;
    els.llmHealth.style.color = 'var(--err)';
  }
}

/**
 * Pinta la lista de reglas de descarga configuradas.
 *
 * @returns {Promise<void>}
 */
async function refreshRules() {
  try {
    const data = await apiCall('/api/downloads/rules');
    renderRules(data.rules ?? []);
  } catch (error) {
    els.rulesList.innerHTML = '';
    const li = document.createElement('li');
    li.textContent = `Error: ${error.message}`;
    els.rulesList.appendChild(li);
  }
}

/**
 * Procesa el envío del formulario de chat. Si la línea empieza por `/`, es un slash command;
 * si no, se manda al LLM con todo el historial como contexto.
 *
 * @param {Event} event
 */
async function handleChatSubmit(event) {
  event.preventDefault();
  const raw = els.chatInput.value.trim();
  if (!raw) return;

  els.chatInput.value = '';
  els.chatSubmit.disabled = true;

  try {
    if (raw.startsWith('/')) {
      await runSlashCommand(raw);
    } else {
      await runChatTurn(raw);
    }
  } finally {
    els.chatSubmit.disabled = false;
    els.chatInput.focus();
  }
}

/**
 * Ejecuta un turno conversacional: añade el mensaje del usuario, llama a /api/chat con el
 * historial completo y añade la respuesta del asistente al hilo.
 *
 * @param {string} text
 */
async function runChatTurn(text) {
  appendMessage('user', text);
  conversation.push({ role: 'user', content: text });
  showChatStatus('Pensando…');

  try {
    const data = await apiCall('/api/chat', { method: 'POST', body: { messages: conversation } });
    const reply = data.text ?? '(sin respuesta)';
    conversation.push({ role: 'assistant', content: reply });
    appendMessage('assistant', reply);
    showChatStatus('');
  } catch (error) {
    appendMessage('error', error.message);
    showChatStatus('Error en la respuesta.', true);
  }
}

/**
 * Ejecuta un slash command sobre la API correspondiente y añade el resultado al historial.
 *
 * @param {string} line
 */
async function runSlashCommand(line) {
  const trimmed = line.trim().slice(1);
  const space = trimmed.search(/\s/);
  const name = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const args = space === -1 ? '' : trimmed.slice(space + 1).trim();

  if (name === 'help') {
    appendMessage('system', [
      'Comandos disponibles:',
      '  /fetch <url>     — descarga la URL y la añade al contexto',
      '  /search <query>  — busca en la web y añade los resultados al contexto',
      '  /ha <texto>      — pedir algo a Home Assistant',
      '  /reset           — vacía la conversación',
      '  /help            — esta ayuda',
    ].join('\n'));
    return;
  }

  if (name === 'reset' || name === 'clear') {
    conversation.length = 1; // mantener system prompt
    sessionState.haConversationId = null;
    els.conversation.innerHTML = '';
    appendMessage('system', 'Historial vaciado.');
    return;
  }

  if (name === 'ha') {
    if (!args) {
      appendMessage('error', 'Uso: /ha <texto> — ej: /ha enciende el termostato');
      return;
    }
    showChatStatus('Hablando con Home Assistant…');
    try {
      const data = await apiCall('/api/ha', {
        method: 'POST',
        body: { text: args, conversationId: sessionState.haConversationId ?? undefined },
      });
      if (data.conversationId) sessionState.haConversationId = data.conversationId;
      const icon = data.responseType === 'error' ? '⚠️' : '🏠';
      appendMessage('system', `${icon} ${data.speech || '(sin respuesta)'}`);
      showChatStatus('');
    } catch (error) {
      appendMessage('error', error.message);
      showChatStatus('Home Assistant falló.', true);
    }
    return;
  }

  if (name === 'fetch') {
    if (!args) {
      appendMessage('error', 'Uso: /fetch <url>');
      return;
    }
    showChatStatus(`Descargando ${args}…`);
    try {
      const data = await apiCall('/api/fetch', { method: 'POST', body: { url: args } });
      const label = data.title ? `${data.title} — ${data.url}` : data.url;
      conversation.push({
        role: 'user',
        content: `[CONTEXT: Fetched ${data.url}]\n# ${data.title || '(sin título)'}\n\n${data.text}`,
      });
      conversation.push({ role: 'assistant', content: 'Got it.' });
      appendMessage('system', `Añadidos ${data.bytes} bytes de ${label} al contexto.`);
      showChatStatus('');
    } catch (error) {
      appendMessage('error', error.message);
      showChatStatus('Fetch fallido.', true);
    }
    return;
  }

  if (name === 'search') {
    if (!args) {
      appendMessage('error', 'Uso: /search <query>');
      return;
    }
    showChatStatus(`Buscando "${args}"…`);
    try {
      const data = await apiCall('/api/search', { method: 'POST', body: { query: args } });
      const results = Array.isArray(data.results) ? data.results : [];
      if (results.length === 0) {
        appendMessage('system', 'Sin resultados.');
        return;
      }
      const formatted = results.map((result, index) =>
        `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`
      ).join('\n');
      appendMessage('search', formatted);
      conversation.push({
        role: 'user',
        content: `[CONTEXT: Search "${args}"]\n${formatted}`,
      });
      conversation.push({ role: 'assistant', content: 'Got it.' });
      showChatStatus('');
    } catch (error) {
      appendMessage('error', error.message);
      showChatStatus('Búsqueda fallida.', true);
    }
    return;
  }

  appendMessage('error', `Comando desconocido: /${name}. Prueba /help.`);
}

/**
 * Añade un mensaje al hilo de conversación visible.
 *
 * @param {'user'|'assistant'|'system'|'error'|'search'} role
 * @param {string} content
 */
function appendMessage(role, content) {
  const wrapper = document.createElement('div');
  wrapper.className = `message message--${role}`;
  const labelMap = {
    user: 'Tú',
    assistant: 'luis',
    system: 'sistema',
    error: 'error',
    search: 'búsqueda',
  };
  const label = document.createElement('div');
  label.className = 'message__label';
  label.textContent = labelMap[role] ?? role;
  const body = document.createElement('pre');
  body.className = 'message__body';
  body.textContent = content;
  wrapper.appendChild(label);
  wrapper.appendChild(body);
  els.conversation.appendChild(wrapper);
  els.conversation.scrollTop = els.conversation.scrollHeight;
}

/**
 * Pinta la lista de módulos del asistente.
 *
 * @param {Array<{ name: string, status: string, note?: string }>} modules
 */
function renderModules(modules) {
  els.modulesList.innerHTML = '';
  for (const moduleStatus of modules) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = moduleStatus.name;
    const state = document.createElement('span');
    state.className = 'mod-state';
    state.dataset.state = moduleStatus.status;
    state.textContent = moduleStatus.note ? `${moduleStatus.status} (${moduleStatus.note})` : moduleStatus.status;
    li.appendChild(name);
    li.appendChild(state);
    els.modulesList.appendChild(li);
  }
}

/**
 * Pinta la lista de reglas de descarga.
 *
 * @param {Array<{ name: string, extensions: string[], targetPath: string }>} rules
 */
function renderRules(rules) {
  els.rulesList.innerHTML = '';
  if (rules.length === 0) {
    const li = document.createElement('li');
    li.textContent = '(ninguna configurada)';
    els.rulesList.appendChild(li);
    return;
  }
  for (const rule of rules) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'rule-name';
    name.textContent = rule.name;
    li.appendChild(name);
    const meta = document.createElement('span');
    meta.className = 'rule-meta';
    meta.textContent = `${rule.extensions.join(', ')} → ${rule.targetPath}`;
    li.appendChild(meta);
    els.rulesList.appendChild(li);
  }
}

/**
 * Cambia el indicador del estado general (cabecera).
 *
 * @param {'unknown' | 'ok' | 'warn' | 'err'} state
 */
function setOverallDot(state) {
  els.statusDot.dataset.state = state;
}

/**
 * Pinta o limpia el mensaje de estado del chat.
 *
 * @param {string} text
 * @param {boolean} [isError]
 */
function showChatStatus(text, isError = false) {
  els.chatStatus.textContent = text;
  els.chatStatus.style.color = isError ? 'var(--err)' : 'var(--muted)';
}

els.chatForm.addEventListener('submit', handleChatSubmit);
els.chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    els.chatForm.requestSubmit();
  }
});
els.refreshBtn.addEventListener('click', () => void initialise());
els.resetBtn.addEventListener('click', () => {
  conversation.length = 1;
  els.conversation.innerHTML = '';
  appendMessage('system', 'Historial vaciado.');
});

/**
 * Carga el estado inicial al abrir la página.
 *
 * @returns {Promise<void>}
 */
async function initialise() {
  await Promise.all([refreshStatus(), refreshLlmStatus(), refreshRules()]);
}

void initialise();
