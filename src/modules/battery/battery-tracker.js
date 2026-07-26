import { readFile } from 'node:fs/promises';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_JUMP_MIN = 90; // nuevo nivel debe ser ≥ este valor
const DEFAULT_PREV_MAX = 50; // nivel anterior debe estar por debajo de este valor

/** ¿El estado de HA es un número de batería válido (0..100)? */
export function isFiniteLevel(value) {
  if (value == null) return false;
  if (value === 'unknown' || value === 'unavailable') return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

/**
 * Un cambio de pila se detecta como un SALTO al alza: el nivel nuevo es alto
 * (≥ jumpMin) mientras el anterior estaba bajo (< prevMax). Un descenso normal,
 * o pequeñas subidas por temperatura, no lo disparan.
 */
export function isBatteryChange(prevLevel, newLevel, { jumpMin = DEFAULT_JUMP_MIN, prevMax = DEFAULT_PREV_MAX } = {}) {
  if (prevLevel == null || !Number.isFinite(prevLevel)) return false;
  if (!Number.isFinite(newLevel)) return false;
  return newLevel >= jumpMin && prevLevel < prevMax;
}

/** Días enteros (redondeados) entre dos fechas ISO. */
export function daysBetween(fromIso, toIso) {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.round((to - from) / DAY_MS));
}

/** ISO → "dd/mm/aaaa" (es-ES). */
export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** Días a texto legible en español: "45 días (~1,5 meses)". */
export function humanizeDuration(days) {
  if (days == null) return null;
  if (days < 60) return `${days} ${days === 1 ? 'día' : 'días'}`;
  const months = Math.round((days / 30.44) * 10) / 10;
  const monthsText = String(months).replace('.', ',');
  return `${days} días (~${monthsText} meses)`;
}

/** Mensaje de Telegram en español claro y descriptivo. */
export function buildChangeMessage({ name, level, prevChange, nowIso }) {
  const head = `🔋 Pila cambiada en «${name}» (nivel ${level}%).`;
  if (!prevChange) {
    return `${head} Es el primer cambio que registro; a partir de ahora mediré cuánto dura.`;
  }
  const days = daysBetween(prevChange.date, nowIso);
  const dur = humanizeDuration(days);
  return `${head} La anterior duró ${dur} (del ${formatDate(prevChange.date)} al ${formatDate(nowIso)}).`;
}

const normalize = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Parsea el CSV semilla de cambios de pila. Formatos aceptados (con cabecera):
 *   fecha,entity_id,nombre,nivel      (preferido: entity_id directo)
 *   fecha,sensor,nivel                (legado: nombre libre, se resuelve por tokens)
 * Devuelve filas { date, entityId?, sensor?, name?, level }.
 */
export function parseSeedCsv(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const header = lines[0].toLowerCase();
  const hasHeader = /fecha|date/.test(header) && header.includes(',');
  const cols = hasHeader ? header.split(',').map((c) => c.trim()) : null;
  const idx = (name) => (cols ? cols.indexOf(name) : -1);
  const iEntity = idx('entity_id');
  const iName = idx('nombre') >= 0 ? idx('nombre') : idx('name');
  const iLevel =
    idx('nivel') >= 0 ? idx('nivel') : idx('nivel_al_cambiar') >= 0 ? idx('nivel_al_cambiar') : idx('level');

  const rows = [];
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const parts = line.split(',').map((p) => p.trim());
    const date = parts[0];
    if (!date) continue;
    const levelRaw = iLevel >= 0 ? parts[iLevel] : parts[parts.length - 1];
    const level = levelRaw != null && levelRaw !== '' && !Number.isNaN(Number(levelRaw)) ? Number(levelRaw) : null;
    const entityId = iEntity >= 0 ? parts[iEntity] : parts[1]?.includes('.') ? parts[1] : undefined;
    const name = iName >= 0 ? parts[iName] : undefined;
    const sensor = entityId ? undefined : parts[1];
    rows.push({ date, entityId, sensor, name, level });
  }
  return rows;
}

/**
 * Resuelve el entity_id de una fila del seed: si trae entity_id explícito lo usa;
 * si no, hace match best-effort por tokens contra las entidades de batería de HA.
 */
export function resolveSeedEntityId(row, batteryEntities) {
  if (row.entityId && row.entityId.includes('.')) return row.entityId;
  const tokens = normalize(row.sensor).split(' ').filter((t) => t.length > 2);
  if (tokens.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const e of batteryEntities) {
    const hay = normalize(`${e.entity_id} ${e.friendly_name}`);
    const score = tokens.filter((t) => hay.includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return bestScore > 0 ? best.entity_id : null;
}

/**
 * Watcher de cambios de pila. Reutiliza el HomeAssistantStateCache (device_class=battery)
 * y persiste el historial en un store JSON. Detecta el salto de nivel al reponer pila,
 * calcula la duración desde el cambio anterior y avisa por Telegram.
 */
export function createBatteryTracker({
  logger,
  scheduler,
  notificationService,
  stateCache,
  store,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  jumpMin = DEFAULT_JUMP_MIN,
  prevMax = DEFAULT_PREV_MAX,
  seedCsvPath = '',
  nowFn = () => new Date(),
}) {
  if (!stateCache) throw new Error('createBatteryTracker requires stateCache');
  if (!store) throw new Error('createBatteryTracker requires store');

  let job = null;
  let loaded = false;
  let seedImported = false;

  async function notify(text) {
    try {
      await notificationService.sendNotification({ text, level: 'info' });
    } catch (error) {
      logger?.error({ err: error?.message }, 'Battery notification failed to dispatch');
    }
  }

  function listBatteryEntities() {
    return stateCache.findEntities({ deviceClass: 'battery' }).filter((e) => isFiniteLevel(e.state));
  }

  /** Importa el CSV semilla en el historial (solo una vez, si el store no tiene aún historial). */
  async function maybeImportSeed(batteryEntities) {
    if (seedImported || !seedCsvPath || !store.isEmpty()) {
      seedImported = true;
      return;
    }
    let text;
    try {
      text = await readFile(seedCsvPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn({ err: error.message, seedCsvPath }, 'battery seed CSV read failed');
      }
      seedImported = true;
      return;
    }
    let imported = 0;
    for (const row of parseSeedCsv(text)) {
      const entityId = resolveSeedEntityId(row, batteryEntities);
      if (!entityId) {
        logger?.warn({ row }, 'battery seed row could not be resolved to an entity');
        continue;
      }
      const match = batteryEntities.find((e) => e.entity_id === entityId);
      const name = row.name || match?.friendly_name || entityId;
      store.recordChange(entityId, {
        date: new Date(row.date).toISOString(),
        level: row.level ?? 100,
        name,
        seeded: true,
      });
      imported += 1;
    }
    seedImported = true;
    if (imported > 0) logger?.info({ imported }, 'battery seed history imported');
  }

  async function checkOnce() {
    if (!loaded) {
      await store.load();
      loaded = true;
    }

    const entities = listBatteryEntities();
    if (entities.length === 0) {
      logger?.debug?.('battery tracker: no battery entities available yet');
      return;
    }

    await maybeImportSeed(entities);

    const nowIso = nowFn().toISOString();
    let dirty = false;

    for (const entity of entities) {
      const level = Number(entity.state);
      const prev = store.getLastLevel(entity.entity_id);

      if (prev == null) {
        // Primer avistamiento: fijamos línea base, sin avisar (no es un cambio).
        store.setLastLevel(entity.entity_id, level);
        dirty = true;
        continue;
      }

      if (isBatteryChange(prev, level, { jumpMin, prevMax })) {
        const history = store.getHistory(entity.entity_id);
        const prevChange = history.at(-1) ?? null;
        const name = entity.friendly_name || entity.entity_id;
        store.recordChange(entity.entity_id, { date: nowIso, level, name });
        store.setLastLevel(entity.entity_id, level);
        dirty = true;
        logger?.info({ entity: entity.entity_id, level }, 'battery change detected');
        await notify(buildChangeMessage({ name, level, prevChange, nowIso }));
      } else if (level !== prev) {
        store.setLastLevel(entity.entity_id, level);
        dirty = true;
      }
    }

    if (dirty) await store.save();
  }

  function start() {
    if (job) return;
    job = scheduler.schedule(checkOnce, checkIntervalMs, 'battery-tracker');
    logger?.info({ intervalMs: checkIntervalMs }, 'Battery tracker started');
  }

  function stop() {
    job?.stop();
    job = null;
  }

  return { start, stop, checkOnce };
}
