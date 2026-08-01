import { summarise } from './dishwasher-history-store.js';

const DEFAULT_IDLE_INTERVAL_MS = 30 * 60 * 1000; // 30 min cuando no hay lavado
const DEFAULT_ACTIVE_INTERVAL_MS = 2 * 60 * 1000; // 2 min con un ciclo en marcha
const END_STATE = 'program_ended';
// Estados en los que hay un ciclo en curso o programado → merece sondeo rápido.
const ACTIVE_STATES = new Set(['programmed', 'in_use', 'pause', 'rinse_hold', 'waiting_to_start', 'reserved']);

/** ¿El estado indica un ciclo en marcha/programado (→ sondeo rápido)? */
export function isActiveState(state) {
  return ACTIVE_STATES.has(state);
}

/** ¿Es un número válido (no 'unknown'/'unavailable')? */
export function parseNumber(value) {
  if (value == null || value === 'unknown' || value === 'unavailable' || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** "eco" → "Eco", "quick_power_wash" → "Quick power wash". */
export function prettyProgram(program) {
  if (!program || program === 'no_program') return '—';
  return program.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d).replace('.', ',') : '—');

/**
 * Mensaje de Telegram: consumo del lavado + acumulados hoy/semana/mes/año.
 *
 * @param {{ energy: number|null, water: number|null, program: string }} cycle
 * @param {{ today, week, month, year }} agg
 * @returns {string}
 */
export function buildReport(cycle, agg) {
  const line = (label, a) => `${label} ${a.count} lavado${a.count === 1 ? '' : 's'} · ${fmt(a.energy)} kWh · ${fmt(a.water, 0)} L`;
  return [
    `🍽️ Lavavajillas terminado — programa ${prettyProgram(cycle.program)}`,
    `Este lavado: ${fmt(cycle.energy)} kWh · ${fmt(cycle.water, 0)} L`,
    '',
    line('📅 Hoy:', agg.today),
    line('📆 Semana:', agg.week),
    line('🗓️ Mes:', agg.month),
    line('📊 Año:', agg.year),
  ].join('\n');
}

/**
 * Vigila el lavavajillas (Miele vía HA): al terminar un ciclo (program_ended)
 * registra el consumo del lavado y avisa por Telegram con los acumulados.
 * Los sensores de energía/agua son total_increasing y se resetean entre ciclos,
 * así que se guarda el último valor válido durante el ciclo para no perderlo.
 */
export function createDishwasherWatcher({
  logger,
  scheduler,
  notificationService,
  stateCache,
  store,
  idleIntervalMs = DEFAULT_IDLE_INTERVAL_MS,
  activeIntervalMs = DEFAULT_ACTIVE_INTERVAL_MS,
  stateEntity = 'sensor.lavavajillas',
  energyEntity = 'sensor.lavavajillas_consumo_de_energia',
  waterEntity = 'sensor.lavavajillas_consumo_de_agua',
  programEntity = 'sensor.lavavajillas_programa',
  nowFn = () => new Date(),
}) {
  if (!stateCache) throw new Error('createDishwasherWatcher requires stateCache');
  if (!store) throw new Error('createDishwasherWatcher requires store');

  let timer = null;
  let running = false;
  let loaded = false;
  // Último valor válido observado durante el ciclo (los sensores se resetean).
  let lastEnergy = null;
  let lastWater = null;
  let lastProgram = null;

  function getState(entityId) {
    const list = stateCache.findEntities({});
    const e = list.find((x) => x.entity_id === entityId);
    return e ? e.state : null;
  }

  async function notify(text) {
    try {
      await notificationService.sendNotification({ text, level: 'info' });
    } catch (error) {
      logger?.error({ err: error?.message }, 'Dishwasher notification failed to dispatch');
    }
  }

  async function checkOnce() {
    if (!loaded) {
      await store.load();
      loaded = true;
    }

    const current = getState(stateEntity);
    if (current == null) {
      logger?.debug?.('dishwasher watcher: sensor no disponible todavía');
      return;
    }

    // Acumular el último valor válido de consumos/programa mientras el ciclo corre.
    const e = parseNumber(getState(energyEntity));
    const w = parseNumber(getState(waterEntity));
    const p = getState(programEntity);
    if (e != null) lastEnergy = e;
    if (w != null) lastWater = w;
    if (p && p !== 'no_program') lastProgram = p;

    const prev = store.getLastState();

    // Transición a program_ended = fin de un ciclo.
    if (current === END_STATE && prev !== END_STATE) {
      const cycle = {
        date: nowFn().toISOString(),
        energy: e ?? lastEnergy,
        water: w ?? lastWater,
        program: (p && p !== 'no_program' ? p : lastProgram) ?? 'no_program',
      };
      store.addCycle(cycle);
      store.setLastState(current);
      await store.save();
      logger?.info({ energy: cycle.energy, water: cycle.water, program: cycle.program }, 'dishwasher cycle ended');
      const agg = summarise(store.getCycles(), nowFn().getTime());
      await notify(buildReport(cycle, agg));
      // reiniciar acumuladores para el siguiente ciclo
      lastEnergy = null; lastWater = null; lastProgram = null;
      return;
    }

    if (current !== prev) {
      store.setLastState(current);
      await store.save();
    }
  }

  /** Próximo intervalo según el estado guardado: rápido si hay ciclo, lento si no. */
  function nextDelayMs() {
    return isActiveState(store.getLastState()) ? activeIntervalMs : idleIntervalMs;
  }

  function scheduleNext(delayMs) {
    timer = scheduler.delay(async () => {
      if (!running) return;
      await checkOnce().catch((error) => logger?.warn({ err: error?.message }, 'Dishwasher check failed'));
      if (running) scheduleNext(nextDelayMs());
    }, delayMs);
  }

  function start() {
    if (running) return;
    running = true;
    logger?.info({ idleIntervalMs, activeIntervalMs }, 'Dishwasher watcher started (sondeo adaptativo)');
    // Primera comprobación con retardo: fija la línea base y da tiempo al state
    // cache de HA a cargar (arranca vacío). Después se auto-reprograma según el
    // estado (2 min si hay ciclo, 30 min en reposo).
    scheduleNext(45 * 1000);
  }

  function stop() {
    running = false;
    timer?.cancel?.();
    timer = null;
  }

  return { start, stop, checkOnce };
}
