/**
 * Bloque "Calefacción salón" del informe (LUI-TSK-0129). Lee los contadores
 * history_stats que Home Assistant calcula sobre el termostato Netatmo
 * (LUI-TSK-0128) y los resume en HTML de Telegram.
 */

const HEATING_NOW = 'binary_sensor.calefaccion_salon_calentando';
const PERIODS = [
  { label: 'Hoy', starts: 'sensor.calefaccion_salon_arranques_hoy', hours: 'sensor.calefaccion_salon_horas_hoy' },
  { label: 'Esta semana', starts: 'sensor.calefaccion_salon_arranques_semana', hours: 'sensor.calefaccion_salon_horas_semana' },
];
const TITLE = '🔥 <b>Calefacción salón</b>';

/** @param {number} hours */
function durationLabel(hours) {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * @param {Array<{ entity_id: string, state: string }>} states - /api/states de HA
 * @returns {string} HTML de Telegram
 */
export function formatHeatingReport(states) {
  const byId = new Map(states.map((s) => [s.entity_id, s.state]));
  const num = (id) => {
    const value = Number.parseFloat(byId.get(id));
    return Number.isFinite(value) ? value : null;
  };

  const lines = [];
  for (const { label, starts, hours } of PERIODS) {
    const count = num(starts);
    const time = num(hours);
    if (count === null || time === null) {
      return `${TITLE}\nSin datos: Home Assistant no tiene los contadores de la calefacción.`;
    }
    if (count === 0) {
      lines.push(`${label}: no ha arrancado`);
      continue;
    }
    const noun = count === 1 ? 'arranque' : 'arranques';
    lines.push(`${label}: ${count} ${noun} · ${durationLabel(time)}`);
  }
  if (byId.get(HEATING_NOW) === 'on') lines.push('Está calentando ahora.');
  return `${TITLE}\n${lines.join('\n')}`;
}

// Salas con válvula Netatmo; sus helpers están en HA (LUI-TSK-0130).
const RADIATORS = [
  { room: 'dormitorio_dani', label: 'Dormitorio Dani' },
  { room: 'dormitorio_principal', label: 'Dormitorio Principal' },
  { room: 'despacho', label: 'Despacho' },
  { room: 'dormitorio_pabli', label: 'Dormitorio Pabli' },
];
const RADIATORS_TITLE = '♨️ <b>Radiadores</b>\nReparto estimado del gas por horas de válvula abierta:';
const NO_DATA_STATES = new Set([undefined, 'unavailable', 'unknown']);

/**
 * Bloque "Radiadores" (LUI-TSK-0131): horas de calor de cada válvula y su
 * parte de la semana. Es una estimación del gas: HA no mide consumo.
 *
 * @param {Array<{ entity_id: string, state: string }>} states - /api/states de HA
 * @returns {string} HTML de Telegram
 */
export function formatRadiatorsReport(states) {
  const byId = new Map(states.map((s) => [s.entity_id, s.state]));
  const num = (id) => {
    const value = Number.parseFloat(byId.get(id));
    return Number.isFinite(value) ? value : null;
  };

  const rooms = RADIATORS.map(({ room, label }) => {
    const now = byId.get(`binary_sensor.radiador_${room}_calentando`);
    const today = num(`sensor.radiador_${room}_horas_hoy`);
    const week = num(`sensor.radiador_${room}_horas_semana`);
    const hasData = !NO_DATA_STATES.has(now) && today !== null && week !== null;
    return { label, hasData, heatingNow: now === 'on', today, week };
  });
  const totalWeek = rooms.reduce((sum, r) => (r.hasData ? sum + r.week : sum), 0);

  const lines = rooms.map(({ label, hasData, heatingNow, today, week }) => {
    if (!hasData) return `${label}: sin datos (¿pila?)`;
    if (totalWeek === 0) return `${label}: no ha pedido calor esta semana`;
    const todayLabel = today === 0 ? 'hoy nada' : `hoy ${durationLabel(today)}`;
    const share = Math.round((week / totalWeek) * 100);
    const weekLabel = week === 0 ? 'semana nada' : `semana ${durationLabel(week)}`;
    const nowLabel = heatingNow ? ' · calentando ahora' : '';
    return `${label}: ${todayLabel} · ${weekLabel} (${share} %)${nowLabel}`;
  });
  return `${RADIATORS_TITLE}\n${lines.join('\n')}`;
}

/** @param {string} text */
function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Lee HA y devuelve el bloque listo para enviar. Si HA falla, el bloque lo dice
 * con el motivo: el informe no se queda callado ni se cae.
 *
 * @param {() => Promise<Array<{ entity_id: string, state: string }>>} fetchStates
 * @returns {Promise<string>}
 */
export async function buildHeatingReport(fetchStates) {
  try {
    const states = await fetchStates();
    return `${formatHeatingReport(states)}\n\n${formatRadiatorsReport(states)}`;
  } catch (error) {
    return `${TITLE}\n⚠️ No pude leer la calefacción: ${escapeHtml(String(error?.message ?? error))}`;
  }
}
