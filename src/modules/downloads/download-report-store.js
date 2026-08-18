import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Store JSON de los reports de descargas movidas al NAS (LUI-TSK-0095).
 *
 * En vez de reenviar cada report a Telegram de madrugada, `notify-move-reports.sh`
 * los manda al endpoint /api/hooks/download-report, que los ACUMULA aquí. El parte
 * diario de salud (07:30) los incluye con su desglose completo. Se podan los que
 * superan `maxAgeMs` (48h por defecto) para que el fichero no crezca sin fin.
 *
 * Shape en disco: { "reports": [ { "ts": ISO, "message": string } ] }
 */
export function createDownloadReportStore({ filePath, logger, maxAgeMs = 48 * 60 * 60 * 1000 }) {
  if (!filePath) throw new Error('createDownloadReportStore requires filePath');

  let data = { reports: [] };

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      data = { reports: Array.isArray(parsed?.reports) ? parsed.reports : [] };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn({ err: error.message, filePath }, 'download-report-store read failed');
      }
      data = { reports: [] };
    }
    return data;
  }

  async function save() {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  return {
    load,
    save,
    /** Añade un report y poda los viejos; persiste. */
    async add(message, now = new Date()) {
      data.reports.push({ ts: now.toISOString(), message });
      data.reports = data.reports.filter((r) => now.getTime() - new Date(r.ts).getTime() <= maxAgeMs);
      await save();
    },
    /** Mensajes de los reports de las últimas `sinceMs` (por defecto 24h). */
    recent(sinceMs = 24 * 60 * 60 * 1000, now = Date.now()) {
      return reportsSince(data.reports, sinceMs, now).map((r) => r.message);
    },
    get data() { return data; },
  };
}

/**
 * Reports con antigüedad menor que `sinceMs` respecto a `nowMs` (función pura).
 *
 * @param {Array<{ ts: string, message: string }>} reports
 * @param {number} sinceMs
 * @param {number} nowMs
 * @returns {Array<{ ts: string, message: string }>}
 */
export function reportsSince(reports, sinceMs, nowMs) {
  const from = nowMs - sinceMs;
  return (reports ?? []).filter((r) => {
    const t = new Date(r?.ts).getTime();
    return Number.isFinite(t) && t >= from;
  });
}
