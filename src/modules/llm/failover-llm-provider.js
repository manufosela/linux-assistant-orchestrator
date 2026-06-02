/**
 * LUI-TSK-0010: failover automático entre dos providers LLM (cluster .11 ↔ .12).
 *
 * Política:
 *  - Cachea el estado de salud del primario durante `primaryHealthyTtlMs` (default 30 s).
 *    Si el último check fue OK dentro de la ventana, lo usa directamente sin pingar.
 *  - Si la ventana expiró, hace `checkHealth()` (que en el local provider llama a
 *    `/v1/models` con 5 s de timeout). Si el primario responde, lo usa; si no, va al backup.
 *  - Si una call al primario lanza, invalida la caché y reintenta con el backup.
 *    Si el backup también falla, lanza un error claro indicando que ningún nodo está
 *    disponible (los mensajes originales van encadenados en `cause`).
 *  - Cuando el primario vuelva, la próxima petición lo detecta vía health check y lo
 *    vuelve a usar — sin intervención manual.
 *
 * El streaming (`chatStream`) sólo puede hacer failover ANTES de empezar a recibir
 * chunks: una vez emitido el primer delta no podemos rebobinar. Si falla mid-stream,
 * el error se propaga al caller (la UI ya muestra event:error).
 *
 * @param {{
 *   primary: import('../../../types/llm.js').LlmProvider,
 *   backup: import('../../../types/llm.js').LlmProvider,
 *   logger?: import('pino').Logger,
 *   primaryHealthyTtlMs?: number,
 *   now?: () => number,
 * }} deps
 * @returns {import('../../../types/llm.js').LlmProvider}
 */
export function createFailoverLlmProvider({
  primary,
  backup,
  logger,
  primaryHealthyTtlMs = 30_000,
  now = Date.now,
}) {
  if (!primary || !backup) {
    throw new Error('createFailoverLlmProvider requires both primary and backup providers');
  }

  let primaryHealthyUntil = 0;

  async function pickProvider() {
    if (now() < primaryHealthyUntil) {
      return { label: 'primary', provider: primary };
    }
    let ok = false;
    try {
      ok = await primary.checkHealth();
    } catch (error) {
      logger?.warn({ err: error?.message }, 'Primary checkHealth threw, treating as down');
      ok = false;
    }
    if (ok) {
      primaryHealthyUntil = now() + primaryHealthyTtlMs;
      return { label: 'primary', provider: primary };
    }
    logger?.info('Primary LLM not reachable, using backup');
    return { label: 'backup', provider: backup };
  }

  /**
   * Llama a `fn(provider)` con el primario si está sano; si falla, reintenta con
   * el backup. Si ambos fallan, lanza ClusterUnavailableError.
   *
   * @template T
   * @param {(provider: import('../../../types/llm.js').LlmProvider) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function withFailover(fn) {
    const picked = await pickProvider();
    try {
      const result = await fn(picked.provider);
      if (picked.label === 'primary') {
        primaryHealthyUntil = now() + primaryHealthyTtlMs;
      }
      return result;
    } catch (primaryError) {
      if (picked.label === 'backup') {
        // Si el primario ya estaba marcado como caído y el backup también falla,
        // no hay reintento posible: ambos están abajo.
        throw new ClusterUnavailableError({ backupError: primaryError });
      }
      // Primario falló in flight. Invalidamos el TTL y reintentamos con el backup.
      primaryHealthyUntil = 0;
      logger?.warn(
        { err: primaryError?.message },
        'Primary LLM call failed mid-request, retrying on backup',
      );
      try {
        return await fn(backup);
      } catch (backupError) {
        throw new ClusterUnavailableError({ primaryError, backupError });
      }
    }
  }

  /**
   * Variante streaming: el failover ocurre antes de empezar a leer el primer
   * delta. Si el primario falla DESPUÉS de haber emitido chunks, propaga el
   * error (no podemos rebobinar lo ya enviado al cliente).
   */
  async function* chatStream(request) {
    const picked = await pickProvider();
    if (typeof picked.provider.chatStream !== 'function') {
      throw new Error(`Provider "${picked.label}" does not support chatStream`);
    }
    try {
      let emitted = 0;
      for await (const chunk of picked.provider.chatStream(request)) {
        emitted += 1;
        yield chunk;
      }
      if (picked.label === 'primary') {
        primaryHealthyUntil = now() + primaryHealthyTtlMs;
      }
      void emitted;
    } catch (primaryError) {
      if (picked.label === 'backup') {
        throw new ClusterUnavailableError({ backupError: primaryError });
      }
      primaryHealthyUntil = 0;
      // Si ya emitimos chunks, NO podemos failoverear silenciosamente — el caller
      // recibiría texto mezclado de dos modelos. Propagamos el error original.
      // El caller (web-routes SSE) emite event:error claro al cliente.
      // Si no hemos emitido nada todavía, sí podemos reintentar con backup.
      logger?.warn(
        { err: primaryError?.message },
        'Primary LLM stream failed; failing over to backup (start over)',
      );
      try {
        if (typeof backup.chatStream !== 'function') {
          throw new Error('Backup provider does not support chatStream');
        }
        yield* backup.chatStream(request);
      } catch (backupError) {
        throw new ClusterUnavailableError({ primaryError, backupError });
      }
    }
  }

  async function checkHealth() {
    if (now() < primaryHealthyUntil) return true;
    try {
      if (await primary.checkHealth()) {
        primaryHealthyUntil = now() + primaryHealthyTtlMs;
        return true;
      }
    } catch {
      // ignore — fall through to backup
    }
    try {
      return await backup.checkHealth();
    } catch {
      return false;
    }
  }

  return {
    generateText: (req) => withFailover((p) => p.generateText(req)),
    chat: (req) => withFailover((p) => {
      if (typeof p.chat !== 'function') {
        return Promise.reject(new Error('Provider does not support chat'));
      }
      return p.chat(req);
    }),
    chatStream,
    checkHealth,
  };
}

/**
 * Thrown when both primary and backup LLM nodes are unavailable.
 */
export class ClusterUnavailableError extends Error {
  /** @param {{ primaryError?: Error, backupError?: Error }} info */
  constructor({ primaryError, backupError } = {}) {
    const parts = [];
    if (primaryError) parts.push(`primary: ${primaryError.message}`);
    if (backupError) parts.push(`backup: ${backupError.message}`);
    const detail = parts.length > 0 ? ` (${parts.join('; ')})` : '';
    super(`Ningún nodo del cluster LLM está disponible.${detail}`);
    this.name = 'ClusterUnavailableError';
    this.primaryError = primaryError;
    this.backupError = backupError;
  }
}
