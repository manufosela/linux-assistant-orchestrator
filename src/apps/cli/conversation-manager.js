/**
 * Tracks the conversational message history for the interactive REPL.
 *
 * Stores a chronological array of messages (system, user, assistant) and lets the LLM see the
 * full history on every turn. Slash commands push synthetic context messages into the history
 * (e.g. "[Contexto descargado de URL...]") so the model can reason over fetched data and
 * search results in subsequent turns.
 *
 * `reset()` keeps the system prompt and discards everything else.
 *
 * @param {{ systemPrompt: string }} options
 * @returns {ConversationManager}
 */
export function createConversationManager({ systemPrompt }) {
  /** @type {Message[]} */
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  /**
   * Appends a user message.
   *
   * @param {string} content
   */
  function appendUser(content) {
    messages.push({ role: 'user', content });
  }

  /**
   * Appends an assistant message (typically the LLM response).
   *
   * @param {string} content
   */
  function appendAssistant(content) {
    messages.push({ role: 'assistant', content });
  }

  /**
   * Appends a synthetic "context" entry produced by a slash command.
   * Stored as a user message with a clear marker so the model can identify the source.
   *
   * @param {string} label - short label, e.g. "Fetched https://example.com"
   * @param {string} content - the actual content (page text, search results)
   */
  function appendContext(label, content) {
    messages.push({
      role: 'user',
      content: `[CONTEXT: ${label}]\n${content}`,
    });
    messages.push({
      role: 'assistant',
      content: 'Got it — I will use this when answering your next question.',
    });
  }

  /**
   * Returns the full message history (defensive copy).
   *
   * @returns {Message[]}
   */
  function snapshot() {
    return messages.map((message) => ({ ...message }));
  }

  /**
   * Clears the history but keeps the original system prompt.
   */
  function reset() {
    const system = messages.find((m) => m.role === 'system');
    messages.length = 0;
    if (system) messages.push(system);
  }

  /**
   * Returns the number of stored messages (including the system prompt).
   *
   * @returns {number}
   */
  function size() {
    return messages.length;
  }

  return { appendUser, appendAssistant, appendContext, snapshot, reset, size };
}

/**
 * @typedef {{ role: 'system'|'user'|'assistant', content: string }} Message
 */

/**
 * @typedef {Object} ConversationManager
 * @property {(content: string) => void} appendUser
 * @property {(content: string) => void} appendAssistant
 * @property {(label: string, content: string) => void} appendContext
 * @property {() => Message[]} snapshot
 * @property {() => void} reset
 * @property {() => number} size
 */
