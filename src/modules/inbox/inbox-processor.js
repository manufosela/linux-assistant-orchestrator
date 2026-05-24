import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
 *   - foto, documento, estudio   → waiting on Drive upload (TSK-0049)
 *   - revisar                    → low-confidence, waiting on human decision
 *
 * Never throws. On classifier or dispatch error the item is marked 'error'
 * via inboxStore so the user can find it later.
 *
 * @param {{
 *   router: { classify: Function },
 *   inboxStore: { markRouted: Function, markError: Function },
 *   notesPath: string,
 *   logger?: import('pino').Logger,
 *   now?: () => Date,
 * }} deps
 * @returns {InboxProcessor}
 */
export function createInboxProcessor({ router, inboxStore, notesPath, logger, now = () => new Date() }) {
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
        return {
          kind: 'pending-voice',
          markRouted: false,
          message: 'pendiente transcripción (TSK-0048)',
        };
      case 'foto':
      case 'documento':
      case 'estudio':
        return {
          kind: `pending-${classification.category}`,
          markRouted: false,
          message: 'pendiente subida a Drive (TSK-0049)',
        };
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
