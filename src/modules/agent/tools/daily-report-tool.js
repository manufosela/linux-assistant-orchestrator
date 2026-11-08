import { buildHeatingReport } from '../../heating/heating-report.js';

const MAX_TEXT_LENGTH = 300;

/**
 * Herramienta del agente: el informe del día (LUI-TSK-0137). Los mismos datos
 * que el comando /informe: todos los avisos registrados hoy, también los que no
 * salieron por Telegram, y el resumen de calefacción y radiadores.
 *
 * @param {{
 *   notificationLog: { today: () => Array<{ ts: string, text: string, urgent?: boolean }> },
 *   fetchHaStates?: (() => Promise<Array<{ entity_id: string, state: string }>>) | null,
 *   timeZone?: string,
 *   maxEntries?: number,
 * }} deps
 * @returns {import('../tool-registry.js').AgentTool}
 */
export function createDailyReportTool({ notificationLog, fetchHaStates = null, timeZone, maxEntries = 30 }) {
  const hourFormat = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone });

  return {
    name: 'get_daily_report',
    description:
      'Informe del día: los avisos que LUIS ha registrado hoy (lluvia, temperatura, nodos, riego, parte '
      + 'diario...), también los que no se mandaron por Telegram, y el resumen de la calefacción y los radiadores.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      const entries = notificationLog.today();
      const result = {
        total: entries.length,
        avisos: entries.slice(-maxEntries).map(({ ts, text, urgent }) => ({
          hora: hourFormat.format(new Date(ts)),
          urgente: Boolean(urgent),
          texto: toPlainText(text).slice(0, MAX_TEXT_LENGTH),
        })),
      };
      if (entries.length > maxEntries) result.aviso = `Solo van los ${maxEntries} últimos avisos.`;
      // buildHeatingReport ya captura los fallos de HA y lo dice en el texto.
      if (fetchHaStates) result.calefaccion = toPlainText(await buildHeatingReport(fetchHaStates));
      return result;
    },
  };
}

/**
 * Quita el HTML de Telegram (<b>, <i>, <pre>...) y sus entidades.
 *
 * @param {string} html
 * @returns {string}
 */
function toPlainText(html) {
  return String(html ?? '')
    .replaceAll(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
