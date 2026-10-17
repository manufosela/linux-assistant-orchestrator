/**
 * Registry of the capabilities the LLM may call (LUI-TSK-0108).
 *
 * `invoke` never throws for a bad call: unknown tool, bad arguments or an
 * executor error come back as `{ error }` so the model can explain them.
 *
 * @param {AgentTool[]} tools
 * @param {{ logger: import('pino').Logger }} deps
 * @returns {ToolRegistry}
 */
export function createToolRegistry(tools, { logger }) {
  const byName = new Map();
  for (const tool of tools) {
    if (!tool?.name || !tool.description || !tool.parameters || typeof tool.execute !== 'function') {
      throw new Error(`Herramienta mal definida: ${tool?.name ?? '(sin nombre)'}`);
    }
    if (byName.has(tool.name)) {
      throw new Error(`Herramienta duplicada: ${tool.name}`);
    }
    byName.set(tool.name, tool);
  }

  const definitions = () =>
    [...byName.values()].map(({ name, description, parameters }) => ({
      type: 'function',
      function: { name, description, parameters },
    }));

  /**
   * @param {{ name: string, arguments: string }} call  As returned by the model.
   * @returns {Promise<unknown>}
   */
  async function invoke(call) {
    const tool = typeof call?.name === 'string' ? byName.get(call.name) : undefined;
    if (!tool) {
      return { error: `Herramienta desconocida: ${call?.name}` };
    }
    if (call.arguments !== undefined && typeof call.arguments !== 'string') {
      return { error: 'Argumentos no válidos: se esperaba texto JSON' };
    }

    let args;
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return { error: `Argumentos no válidos (no es JSON): ${call.arguments}` };
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return { error: 'Argumentos no válidos: se esperaba un objeto' };
    }
    const missing = (tool.parameters.required ?? []).find((key) => args[key] === undefined);
    if (missing) {
      return { error: `Falta el argumento obligatorio: ${missing}` };
    }
    const invalid = Object.entries(args).find(([key, value]) => !matchesSchema(value, tool.parameters.properties?.[key]));
    if (invalid) {
      return { error: `Argumento no válido: ${invalid[0]}=${JSON.stringify(invalid[1])}` };
    }

    try {
      logger.info({ tool: call.name, args }, 'Agent tool call');
      return await tool.execute(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ tool: call.name, err: message }, 'Agent tool failed');
      return { error: message };
    }
  }

  return { definitions, invoke };
}

const TYPE_CHECKS = {
  string: (value) => typeof value === 'string',
  integer: (value) => Number.isInteger(value),
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  boolean: (value) => typeof value === 'boolean',
};

/**
 * Shallow check of one argument against its property schema (type and enum):
 * enough for the flat parameter objects the tools declare. Undeclared
 * arguments are rejected so the model cannot smuggle extra fields.
 *
 * @param {unknown} value
 * @param {{ type?: string, enum?: unknown[] } | undefined} schema
 * @returns {boolean}
 */
function matchesSchema(value, schema) {
  if (!schema) return false;
  const check = TYPE_CHECKS[schema.type];
  if (check && !check(value)) return false;
  return !schema.enum || schema.enum.includes(value);
}

/**
 * @typedef {Object} AgentTool
 * @property {string} name
 * @property {string} description  What it does, written for the model.
 * @property {{ type: 'object', properties: object, required?: string[] }} parameters  JSON Schema.
 * @property {(args: object) => Promise<unknown>} execute
 */

/**
 * @typedef {Object} ToolRegistry
 * @property {() => Array<object>} definitions  Tools in OpenAI function-calling format.
 * @property {(call: { name: string, arguments: string }) => Promise<unknown>} invoke
 */
