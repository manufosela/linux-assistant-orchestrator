/**
 * Clasificador semántico de descargas (LUI-TSK-0066).
 *
 * Recibe metadata de un fichero descargado en el portátil (nombre, extensión,
 * tamaño y opcionalmente duración) y devuelve la categoría correcta para
 * archivarlo en el NAS. Usado por el script `move-tg-to-nas.sh` cuando su
 * heurística rápida (regex sobre nombre) no logra clasificar con confianza.
 *
 * Categorías válidas:
 *  - PELICULAS, SERIES, ANIME
 *  - LIBROS, COMICS
 *  - AUDIOLIBROS
 *  - OTHER (no encaja en ninguna o el LLM no está seguro → se queda en local)
 *
 * El módulo aplica primero una clasificación determinista por extensión +
 * heurísticas rápidas (igual que el script del portátil pero centralizada).
 * Si la heurística NO es concluyente (devuelve `OTHER` o `low confidence`),
 * delega en el LLM con un prompt acotado. El LLM siempre debe devolver una
 * categoría de la lista o `OTHER` si genuinamente no sabe.
 *
 * @param {{
 *   llmService: import('../llm/llm-service.js').LlmService,
 *   logger?: import('pino').Logger,
 * }} deps
 * @returns {DownloadClassifier}
 */
export function createDownloadClassifier({ llmService, logger }) {
  if (!llmService) throw new Error('createDownloadClassifier requires llmService');

  /**
   * @param {{ filename: string, ext?: string, sizeBytes?: number, durationSec?: number }} input
   * @returns {Promise<{ category: Category, confidence: number, rationale: string, source: 'heuristic'|'llm' }>}
   */
  async function classify(input) {
    const filename = String(input?.filename ?? '').trim();
    if (!filename) {
      throw new Error('filename is required');
    }
    const ext = normaliseExt(input?.ext ?? filename.split('.').pop() ?? '');
    const sizeBytes = Number.isFinite(input?.sizeBytes) ? Number(input.sizeBytes) : null;
    const durationSec = Number.isFinite(input?.durationSec) ? Number(input.durationSec) : null;

    // 1) Heurística rápida (la misma lógica que el script del portátil).
    const heuristic = heuristicClassify({ filename, ext, sizeBytes, durationSec });
    if (heuristic.confidence >= 0.85) {
      logger?.info({ filename, ext, category: heuristic.category, source: 'heuristic' }, 'download-classifier: heuristic match');
      return { ...heuristic, source: 'heuristic' };
    }

    // 2) Fallback al LLM para casos ambiguos.
    const llm = await llmClassify({ filename, ext, sizeBytes, durationSec, llmService, logger });

    // 2b) Si el LLM falló (confidence 0, categoría OTHER) pero la heurística
    // tenía al menos una pista (categoría != OTHER), preferimos la heurística:
    // "algo es mejor que nada en local". El usuario revisa el log y mueve a
    // mano si la heurística se equivocó.
    if (llm.category === 'OTHER' && llm.confidence === 0 && heuristic.category !== 'OTHER') {
      logger?.info(
        { filename, ext, category: heuristic.category, source: 'heuristic-fallback' },
        'download-classifier: LLM unavailable, falling back to heuristic',
      );
      return { ...heuristic, source: 'heuristic-fallback' };
    }

    logger?.info(
      { filename, ext, category: llm.category, confidence: llm.confidence, source: 'llm' },
      'download-classifier: llm classification',
    );
    return { ...llm, source: 'llm' };
  }

  return { classify };
}

const VALID_CATEGORIES = new Set(['PELICULAS', 'SERIES', 'ANIME', 'LIBROS', 'COMICS', 'AUDIOLIBROS', 'OTHER']);
const VIDEO_EXTS = new Set(['mkv', 'mp4', 'avi', 'mov', 'webm', 'm4v']);
const BOOK_EXTS = new Set(['epub', 'mobi', 'azw3', 'fb2']);
const COMIC_EXTS = new Set(['cbz', 'cbr', 'cb7', 'cbt']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'flac', 'ogg', 'opus', 'wav']);

function normaliseExt(raw) {
  return String(raw ?? '').toLowerCase().replace(/^\./, '');
}

/**
 * Heurística determinista. Devuelve confidence alto (>=0.85) sólo en casos
 * obvios; los ambiguos quedan con confidence bajo para que la capa LLM tome
 * la decisión.
 */
function heuristicClassify({ filename, ext, sizeBytes, durationSec }) {
  if (VIDEO_EXTS.has(ext)) {
    // ANIME si el nombre empieza con [GrupoFansub]
    if (/^\[[^\]]+\]/.test(filename)) {
      return { category: 'ANIME', confidence: 0.85, rationale: 'Vídeo con tag [GrupoFansub] al inicio del nombre.' };
    }
    // SERIES si el nombre tiene marca de episodio
    if (/(s\d{1,2}e\d{1,3}|\b\d{1,2}x\d{1,3}\b|season|temporada|capitulo|episode|episodio)/i.test(filename)) {
      return { category: 'SERIES', confidence: 0.9, rationale: 'Vídeo con marca de episodio (S01E01, 1x01, season, …).' };
    }
    // Vídeo sin marca → posible peli, pero podría ser anime o extra suelto. Confidence medio.
    return { category: 'PELICULAS', confidence: 0.55, rationale: 'Vídeo sin marca de episodio (puede ser película o ambigua).' };
  }

  if (BOOK_EXTS.has(ext)) {
    return { category: 'LIBROS', confidence: 0.95, rationale: `Extensión ${ext} clara de libro.` };
  }

  if (COMIC_EXTS.has(ext)) {
    return { category: 'COMICS', confidence: 0.95, rationale: `Extensión ${ext} clara de cómic.` };
  }

  if (ext === 'pdf') {
    if (sizeBytes !== null && sizeBytes > 1_048_576) {
      return { category: 'LIBROS', confidence: 0.7, rationale: 'PDF > 1 MB, probablemente libro (no documento).' };
    }
    return { category: 'OTHER', confidence: 0.3, rationale: 'PDF pequeño, podría ser documento.' };
  }

  if (AUDIO_EXTS.has(ext)) {
    if (durationSec !== null && durationSec > 1800) {
      return { category: 'AUDIOLIBROS', confidence: 0.9, rationale: `Audio de ${Math.round(durationSec / 60)} min, probablemente audiolibro.` };
    }
    if (durationSec !== null) {
      return { category: 'OTHER', confidence: 0.4, rationale: `Audio de ${Math.round(durationSec / 60)} min, probablemente música.` };
    }
    return { category: 'OTHER', confidence: 0.3, rationale: 'Audio sin duración conocida.' };
  }

  return { category: 'OTHER', confidence: 0.1, rationale: `Extensión ${ext || '(ninguna)'} sin regla determinista.` };
}

async function llmClassify({ filename, ext, sizeBytes, durationSec, llmService, logger }) {
  const sizeHint = sizeBytes !== null ? `${Math.round(sizeBytes / 1024)} KB` : 'desconocido';
  const durationHint = durationSec !== null ? `${Math.round(durationSec / 60)} min` : 'desconocido';

  const prompt =
    'Eres un clasificador de descargas multimedia para un usuario que organiza ' +
    'su NAS en carpetas: PELICULAS, SERIES, ANIME, LIBROS, COMICS, AUDIOLIBROS. ' +
    'Devuelve UN ÚNICO JSON con esta forma exacta, sin texto adicional:\n' +
    '{"category":"...","confidence":0.0-1.0,"rationale":"breve explicación en una línea"}\n\n' +
    'Reglas:\n' +
    '- "category" debe ser una de: PELICULAS, SERIES, ANIME, LIBROS, COMICS, AUDIOLIBROS, OTHER.\n' +
    '- Si no estás razonablemente seguro (>=0.7), devuelve "OTHER" para que el archivo no se mueva.\n' +
    '- ANIME = serie/película de animación japonesa (suele incluir tags de grupo de fansubs, nombres japoneses romanizados, OVA, OAD).\n' +
    '- SERIES = TV occidental o serie no-anime, con o sin marca de episodio.\n' +
    '- PELICULAS = largometraje, NO marca de episodio, NO tag de fansub.\n' +
    '- LIBROS = libros electrónicos (epub, mobi, pdf > 1 MB con aspecto de libro).\n' +
    '- COMICS = ficheros cbz/cbr/cb7/cbt, o PDFs con nombre de cómic.\n' +
    '- AUDIOLIBROS = audio largo (>30 min) con nombre de autor/título de libro, no canción ni episodio podcast.\n' +
    '- OTHER = música suelta, documentos, pdfs cortos, vídeos triviales, lo que NO encaje en lo anterior.\n\n' +
    `Datos del archivo:\n` +
    `- Nombre: ${filename}\n` +
    `- Extensión: ${ext || '(ninguna)'}\n` +
    `- Tamaño: ${sizeHint}\n` +
    `- Duración (si aplica): ${durationHint}\n`;

  let raw;
  try {
    raw = await llmService.generateText(prompt, {
      module: 'download-classifier',
      operation: 'classify',
      private: true,
      maxTokens: 256,
      temperature: 0.1,
    });
  } catch (error) {
    logger?.warn({ err: error?.message, filename }, 'download-classifier: LLM call failed');
    return { category: 'OTHER', confidence: 0, rationale: `LLM no disponible: ${error?.message ?? 'error desconocido'}` };
  }

  const parsed = parseClassifyResponse(raw);
  if (!parsed) {
    logger?.warn({ raw: String(raw ?? '').slice(0, 200), filename }, 'download-classifier: response not parseable');
    return { category: 'OTHER', confidence: 0, rationale: 'Respuesta del LLM no parseable.' };
  }
  return parsed;
}

/**
 * Parsea la respuesta del LLM esperando JSON. Tolera prefijos / sufijos
 * (algunos modelos envuelven en ```json … ```). Si la categoría no es
 * válida, fuerza OTHER.
 */
function parseClassifyResponse(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // Busca el primer { y el último } para extraer un bloque JSON aunque
  // venga rodeado de fences markdown u otros adornos.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  const jsonSlice = text.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return null;
  }

  const category = String(parsed?.category ?? '').toUpperCase().trim();
  const confidence = clampNumber(parsed?.confidence, 0, 1);
  const rationale = String(parsed?.rationale ?? '').slice(0, 240);
  if (!VALID_CATEGORIES.has(category)) {
    return { category: 'OTHER', confidence: 0, rationale: `Categoría inválida del LLM: ${category || '(vacía)'}` };
  }
  return { category, confidence, rationale };
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, n));
}

/**
 * @typedef {'PELICULAS'|'SERIES'|'ANIME'|'LIBROS'|'COMICS'|'AUDIOLIBROS'|'OTHER'} Category
 */

/**
 * @typedef {Object} DownloadClassifier
 * @property {(input: { filename: string, ext?: string, sizeBytes?: number, durationSec?: number }) => Promise<{ category: Category, confidence: number, rationale: string, source: 'heuristic'|'llm'|'heuristic-fallback' }>} classify
 */
