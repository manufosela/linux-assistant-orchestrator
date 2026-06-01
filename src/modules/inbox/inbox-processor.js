import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const VOICE_MAX_TRANSCRIPT_PREVIEW = 4000;

/**
 * Inbox processor — glues the classifier (router) to the action layer.
 *
 * Given an item just added to the inbox, it:
 *   1. Calls router.classify(item.meta) to get a category.
 *   2. Dispatches to the action for that category.
 *   3. Annotates the item's meta.json with the classification result.
 *   4. Updates the item status via inboxStore (routed / error / left pending).
 *
 * Actions implemented in this card (TSK-0044):
 *   - idea     → write a markdown note in notesPath/<date>/<id>.md
 *   - tarea    → same, but with "- [ ] " checkbox prefix
 *   - descartar→ mark item routed with routedTo='discarded' (file stays on disk)
 *
 * Pending downstream cards (only annotate + log, no side-effect yet):
 *   - voz                        → waiting on transcription (TSK-0048)
 *   - foto                       → waiting on Drive upload (TSK-0049)
 *   - revisar                    → low-confidence, waiting on human decision
 *
 * Markitdown extraction (TSK-0051, optional):
 *   - documento, estudio → if markitdownClient is configured, extracts text
 *     via the sidecar, writes `extracted.md` in the item dir and annotates
 *     `extraction` in meta.json. Still pending Drive upload (TSK-0049).
 *     If the sidecar fails or is missing, falls back to plain pending.
 *
 * Never throws. On classifier or dispatch error the item is marked 'error'
 * via inboxStore so the user can find it later.
 *
 * @param {{
 *   router: { classify: Function },
 *   inboxStore: { markRouted: Function, markError: Function },
 *   notesPath: string,
 *   markitdownClient?: { convertFile: Function },
 *   logger?: import('pino').Logger,
 *   now?: () => Date,
 * }} deps
 * @returns {InboxProcessor}
 */
const OCR_THRESHOLD_WORDS = 50;

export function createInboxProcessor({
  router,
  inboxStore,
  notesPath,
  markitdownClient = null,
  driveClient = null,
  driveInboxFolderId = null,
  mediaTranscriber = null,
  logger,
  now = () => new Date(),
}) {
  if (!router) throw new Error('createInboxProcessor requires router');
  if (!inboxStore) throw new Error('createInboxProcessor requires inboxStore');
  if (!notesPath) throw new Error('createInboxProcessor requires notesPath');

  /**
   * Processes a single inbox item end-to-end.
   *
   * @param {{ id: string, dir: string, meta: object }} itemRef
   * @returns {Promise<ProcessResult>}
   */
  async function processItem(itemRef) {
    let classification;
    try {
      classification = await router.classify(itemRef.meta);
    } catch (error) {
      // Router is defensive — it shouldn't throw — but never trust the LLM.
      logger?.error({ id: itemRef.id, err: error.message }, 'classifier crashed');
      await safeMarkError(itemRef.id, `classifier crashed: ${error.message}`);
      return { classification: null, action: { kind: 'error', message: error.message } };
    }

    try {
      await annotateClassification(itemRef, classification);
      const action = await dispatch(itemRef, classification);
      if (action.markRouted) {
        await inboxStore.markRouted(itemRef.id, action.routedTo);
      }
      logger?.info(
        { id: itemRef.id, category: classification.category, action: action.kind },
        'inbox.process',
      );
      return { classification, action };
    } catch (error) {
      logger?.error({ id: itemRef.id, err: error.message }, 'inbox dispatch failed');
      await safeMarkError(itemRef.id, error.message);
      return { classification, action: { kind: 'error', message: error.message } };
    }
  }

  async function dispatch(itemRef, classification) {
    switch (classification.category) {
      case 'idea':
        return writeNote(itemRef, 'idea');
      case 'tarea':
        return writeNote(itemRef, 'tarea');
      case 'descartar':
        return {
          kind: 'discarded',
          markRouted: true,
          routedTo: 'discarded',
          message: 'item descartado',
        };
      case 'voz':
        return transcribeVoice(itemRef);
      case 'documento':
      case 'estudio':
        return extractDocument(itemRef, classification.category);
      case 'foto':
        return processPhoto(itemRef);
      case 'revisar':
        return {
          kind: 'needs-review',
          markRouted: false,
          message: 'requiere revisión humana (confidence baja o ambigüedad)',
        };
      default:
        return {
          kind: 'unknown',
          markRouted: false,
          message: `categoría no manejada: ${classification.category}`,
        };
    }
  }

  /**
   * Photos classified by hard rule (no caption → 'foto') may actually be a
   * screenshot of an article, a receipt, a sign. Run OCR via Markitdown and
   * if the text turns out to be substantial (>= OCR_THRESHOLD_WORDS), treat
   * the photo as a 'documento' instead.
   */
  /**
   * Voice notes (TSK-0048): si hay mediaTranscriber configurado, transcribe el
   * audio del item con Whisper y guarda el transcript como `extracted.md`,
   * marcando el item como routed. Si no hay transcriber o falla, deja el
   * item en pending para no perder el audio.
   */
  async function transcribeVoice(itemRef) {
    if (!mediaTranscriber) {
      return {
        kind: 'pending-voice',
        markRouted: false,
        message: 'pendiente transcripción (mediaTranscriber no configurado)',
      };
    }
    if (!itemRef.meta.fileName) {
      return {
        kind: 'pending-voice',
        markRouted: false,
        message: 'pendiente transcripción (item sin fileName)',
      };
    }
    const filePath = join(itemRef.dir, itemRef.meta.fileName);
    try {
      const result = await mediaTranscriber.transcribe(filePath, { withSummary: false });
      const extractedPath = join(itemRef.dir, 'extracted.md');
      const title = itemRef.meta.textCaption ? itemRef.meta.textCaption.slice(0, 80) : 'Voice note';
      const body = [
        `# ${title}`,
        '',
        `> Fuente: voice note (inbox ${itemRef.id})`,
        `> Transcrito: ${now().toISOString()}`,
        '',
        result.transcript.slice(0, VOICE_MAX_TRANSCRIPT_PREVIEW * 100),
      ].join('\n');
      await writeFile(extractedPath, body, 'utf8');
      const words = result.transcript.split(/\s+/).filter(Boolean).length;
      await annotateExtraction(itemRef, {
        path: extractedPath, words, title: null, source: 'whisper',
      });
      return {
        kind: 'voice-transcribed',
        markRouted: true,
        routedTo: `extracted:${extractedPath}`,
        message: `transcrito (${words} palabras)`,
      };
    } catch (error) {
      logger?.warn({ id: itemRef.id, err: error.message }, 'voice transcription failed');
      return {
        kind: 'pending-voice',
        markRouted: false,
        message: `transcripción falló: ${error.message}`,
      };
    }
  }

  async function processPhoto(itemRef) {
    let extractInfo = null;
    let reclassified = false;
    let ocrAttempt = null;
    let ocrError = null;

    if (markitdownClient && itemRef.meta.fileName) {
      const filePath = join(itemRef.dir, itemRef.meta.fileName);
      try {
        const ocr = await markitdownClient.convertFile(filePath);
        const words = (ocr.text ?? '').split(/\s+/).filter(Boolean).length;
        if (words >= OCR_THRESHOLD_WORDS) {
          const extractedPath = join(itemRef.dir, 'extracted.md');
          await writeFile(extractedPath, ocr.text, 'utf8');
          await annotateExtraction(itemRef, {
            path: extractedPath, words, title: ocr.title ?? null, source: 'ocr',
          });
          await overrideCategory(itemRef, 'documento',
            `OCR detectó ${words} palabras → reclasificado desde foto`);
          extractInfo = { words, title: ocr.title ?? null };
          reclassified = true;
        } else {
          await annotateExtraction(itemRef, {
            path: null, words, title: ocr.title ?? null, source: 'ocr-no-text',
          });
          ocrAttempt = { words };
        }
      } catch (error) {
        logger?.warn({ id: itemRef.id, err: error.message }, 'OCR on photo failed');
        ocrError = error.message;
      }
    }

    const finalCategory = reclassified ? 'documento' : 'foto';
    const driveResult = await tryDriveUpload(itemRef, { hasExtracted: !!extractInfo });
    return buildResult(finalCategory, extractInfo, driveResult, { reclassified, ocrAttempt, ocrError });
  }

  async function overrideCategory(itemRef, newCategory, reasonAddendum) {
    const metaPath = join(itemRef.dir, 'meta.json');
    let current;
    try {
      current = JSON.parse(await readFile(metaPath, 'utf8'));
    } catch {
      current = itemRef.meta;
    }
    const previous = current.classification ?? {};
    const next = {
      ...current,
      classification: {
        ...previous,
        category: newCategory,
        reasoning: previous.reasoning ? `${previous.reasoning} | ${reasonAddendum}` : reasonAddendum,
        overriddenFrom: previous.category ?? null,
      },
    };
    await writeFile(metaPath, JSON.stringify(next, null, 2), 'utf8');
  }

  async function extractDocument(itemRef, category) {
    let extractInfo = null;

    if (markitdownClient && itemRef.meta.fileName) {
      const filePath = join(itemRef.dir, itemRef.meta.fileName);
      try {
        const { text, title } = await markitdownClient.convertFile(filePath);
        const extractedPath = join(itemRef.dir, 'extracted.md');
        await writeFile(extractedPath, text ?? '', 'utf8');
        const words = (text ?? '').split(/\s+/).filter(Boolean).length;
        await annotateExtraction(itemRef, { path: extractedPath, words, title: title ?? null });
        extractInfo = { words, title: title ?? null };
      } catch (error) {
        logger?.warn({ id: itemRef.id, err: error.message }, 'markitdown extract failed');
      }
    }

    const driveResult = await tryDriveUpload(itemRef, { hasExtracted: !!extractInfo });
    return buildResult(category, extractInfo, driveResult);
  }

  /**
   * Builds the action result combining extraction info and Drive upload outcome.
   * Centralises the "uploaded / extracted / pending / failed" message logic so
   * processPhoto and extractDocument stay focused on their own flow.
   */
  function buildResult(category, extractInfo, driveResult, { reclassified = false, ocrAttempt = null, ocrError = null } = {}) {
    const extractText = extractInfo
      ? `extraído (${extractInfo.words} palabras${extractInfo.title ? `, "${extractInfo.title}"` : ''})`
      : null;
    const reclassifiedText = reclassified ? ' → reclasificado desde foto' : '';

    if (driveResult.uploaded) {
      const prefix = extractText ? `${extractText}${reclassifiedText} y ` : '';
      return {
        kind: `uploaded-${category}`,
        markRouted: true,
        routedTo: driveResult.routedTo,
        message: `${category} ${prefix}subido a Drive`,
      };
    }
    if (driveResult.error) {
      return {
        kind: `${category}-upload-failed`,
        markRouted: false,
        message: `${category}${extractText ? ` ${extractText}` : ''}${reclassifiedText} — Drive falló: ${driveResult.error}`,
      };
    }
    // Drive skipped (not configured or nothing uploadable)
    if (extractInfo) {
      return {
        kind: `extracted-${category}`,
        markRouted: false,
        message: `${category} ${extractText}${reclassifiedText} — pendiente Drive`,
      };
    }
    // No extraction. For photos, report what the OCR attempt found (if any).
    if (category === 'foto') {
      let message;
      if (ocrError) {
        message = `OCR falló (${ocrError.slice(0, 60)}) — pendiente Drive`;
      } else if (ocrAttempt) {
        message = ocrAttempt.words > 0
          ? `foto (OCR: solo ${ocrAttempt.words} palabras, sin contenido suficiente) — pendiente Drive`
          : 'foto (sin texto OCR) — pendiente Drive';
      } else {
        message = 'pendiente subida a Drive (TSK-0049)';
      }
      return { kind: 'pending-foto', markRouted: false, message };
    }
    return {
      kind: `pending-${category}`,
      markRouted: false,
      message: 'pendiente subida a Drive (TSK-0049)',
    };
  }

  /**
   * Uploads original + (optional) extracted.md to the configured Drive folder.
   *
   * Returns one of:
   *   { uploaded: true, routedTo: 'drive:<id>', webViewLink, uploads }
   *   { uploaded: false, error: 'reason' }     // intentamos pero falló
   *   { uploaded: false, skipped: true }        // no configurado o nada que subir
   */
  async function tryDriveUpload(itemRef, { hasExtracted = false } = {}) {
    if (!driveClient || !driveInboxFolderId) {
      return { uploaded: false, skipped: true };
    }
    const uploads = [];
    try {
      if (itemRef.meta.fileName) {
        const u = await driveClient.uploadFile(
          join(itemRef.dir, itemRef.meta.fileName),
          {
            folderId: driveInboxFolderId,
            mimeType: itemRef.meta.mimeType ?? undefined,
            name: itemRef.meta.fileName,
          },
        );
        uploads.push({ kind: 'original', fileId: u.id, webViewLink: u.webViewLink, name: u.name });
      }
      if (hasExtracted) {
        const u = await driveClient.uploadFile(
          join(itemRef.dir, 'extracted.md'),
          {
            folderId: driveInboxFolderId,
            mimeType: 'text/markdown',
            name: `${itemRef.id.slice(0, 8)}-extracted.md`,
          },
        );
        uploads.push({ kind: 'extracted', fileId: u.id, webViewLink: u.webViewLink, name: u.name });
      }
      if (uploads.length === 0) return { uploaded: false, skipped: true };
      await annotateDrive(itemRef, uploads);
      return {
        uploaded: true,
        routedTo: `drive:${uploads[0].fileId}`,
        webViewLink: uploads[0].webViewLink,
        uploads,
      };
    } catch (error) {
      logger?.warn({ id: itemRef.id, err: error.message }, 'drive upload failed');
      return { uploaded: false, error: error.message.slice(0, 100) };
    }
  }

  async function annotateDrive(itemRef, uploads) {
    const metaPath = join(itemRef.dir, 'meta.json');
    let current;
    try {
      current = JSON.parse(await readFile(metaPath, 'utf8'));
    } catch {
      current = itemRef.meta;
    }
    const next = { ...current, drive: { uploads, at: now().toISOString() } };
    await writeFile(metaPath, JSON.stringify(next, null, 2), 'utf8');
  }

  async function annotateExtraction(itemRef, extraction) {
    const metaPath = join(itemRef.dir, 'meta.json');
    let current;
    try {
      current = JSON.parse(await readFile(metaPath, 'utf8'));
    } catch {
      current = itemRef.meta;
    }
    const next = {
      ...current,
      extraction: { ...extraction, at: now().toISOString() },
    };
    await writeFile(metaPath, JSON.stringify(next, null, 2), 'utf8');
  }

  async function writeNote(itemRef, kind) {
    const dateKey = now().toISOString().slice(0, 10);
    const dir = join(notesPath, dateKey);
    await mkdir(dir, { recursive: true });
    const notePath = join(dir, `${itemRef.id}.md`);
    await writeFile(notePath, formatNote(itemRef, kind), 'utf8');
    return {
      kind,
      markRouted: true,
      routedTo: `note:${notePath}`,
      message: kind === 'tarea' ? `Tarea guardada en ${notePath}` : `Idea guardada en ${notePath}`,
    };
  }

  function formatNote(itemRef, kind) {
    const meta = itemRef.meta;
    const title = kind === 'tarea' ? 'Tarea' : 'Idea';
    const prefix = kind === 'tarea' ? '- [ ] ' : '';
    const caption = meta.textCaption ?? '(sin texto)';
    const lines = [
      `# ${title}`,
      '',
      `> Recibido: ${meta.receivedAt}`,
      '',
      `${prefix}${caption}`,
      '',
      '---',
      '',
      `- id: \`${itemRef.id}\``,
      `- origin: ${meta.origin?.type ?? 'unknown'}`,
    ];
    if (meta.fileName) {
      lines.push(`- adjunto: \`${join(itemRef.dir, meta.fileName)}\``);
    }
    return lines.join('\n');
  }

  /**
   * Re-reads meta.json from disk, merges the classification block, writes back.
   * Re-reading guards against losing fields if meta was updated elsewhere
   * between add() and processItem(), e.g. a future event-driven flow.
   */
  async function annotateClassification(itemRef, classification) {
    const metaPath = join(itemRef.dir, 'meta.json');
    let current;
    try {
      current = JSON.parse(await readFile(metaPath, 'utf8'));
    } catch {
      current = itemRef.meta;
    }
    const next = {
      ...current,
      classification: {
        category: classification.category,
        confidence: classification.confidence,
        reasoning: classification.reasoning,
        at: now().toISOString(),
      },
    };
    await writeFile(metaPath, JSON.stringify(next, null, 2), 'utf8');
  }

  async function safeMarkError(id, error) {
    try {
      await inboxStore.markError(id, error);
    } catch (innerError) {
      logger?.error({ id, err: innerError.message }, 'failed to mark item as error');
    }
  }

  return { processItem };
}

/**
 * @typedef {Object} ProcessResult
 * @property {{ category: string, confidence: number, reasoning: string } | null} classification
 * @property {{ kind: string, markRouted?: boolean, routedTo?: string, message: string }} action
 */

/**
 * @typedef {Object} InboxProcessor
 * @property {(itemRef: { id: string, dir: string, meta: object }) => Promise<ProcessResult>} processItem
 */
