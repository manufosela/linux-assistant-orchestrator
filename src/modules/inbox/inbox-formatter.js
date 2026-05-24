/**
 * Formats inbox query results as HTML for Telegram.
 *
 * Groups items by category, shows count, timestamp, caption and optional
 * preview. Caps per-category listing to avoid huge messages.
 *
 * @param {Array<{ id: string, meta: object, preview: string | null }>} items
 * @param {{ label?: string, maxPerCategory?: number }} [options]
 * @returns {string}
 */
export function formatInboxResults(items, { label = '', maxPerCategory = 5 } = {}) {
  const heading = `📥 <b>Inbox${label ? ` — ${escapeHtml(label)}` : ''}</b>`;

  if (!items || items.length === 0) {
    return `${heading}\n\n<i>Nada guardado en este rango.</i>`;
  }

  const grouped = groupByCategory(items);
  const lines = [`${heading}: ${items.length} item${items.length === 1 ? '' : 's'}`, ''];

  // Iterate in the canonical order so similar runs stay stable.
  for (const category of CATEGORY_ORDER) {
    const catItems = grouped.get(category);
    if (!catItems || catItems.length === 0) continue;
    lines.push(`${EMOJI[category] ?? '🏷️'} <b>${category}</b> (${catItems.length})`);
    for (const item of catItems.slice(0, maxPerCategory)) {
      lines.push(formatItemLine(item));
    }
    if (catItems.length > maxPerCategory) {
      lines.push(`  <i>… +${catItems.length - maxPerCategory} más</i>`);
    }
    lines.push('');
  }

  // Items without a category (still pending classification, errored, etc.)
  const uncategorised = grouped.get(null);
  if (uncategorised && uncategorised.length > 0) {
    lines.push(`🏷️ <b>sin clasificar</b> (${uncategorised.length})`);
    for (const item of uncategorised.slice(0, maxPerCategory)) {
      lines.push(formatItemLine(item));
    }
    if (uncategorised.length > maxPerCategory) {
      lines.push(`  <i>… +${uncategorised.length - maxPerCategory} más</i>`);
    }
  }

  return lines.join('\n').trimEnd();
}

const EMOJI = Object.freeze({
  idea: '💡',
  tarea: '✅',
  documento: '📄',
  estudio: '📚',
  foto: '🖼️',
  voz: '🎙️',
  descartar: '🗑️',
  revisar: '🤔',
});

const CATEGORY_ORDER = Object.freeze([
  'idea', 'tarea', 'documento', 'estudio', 'foto', 'voz', 'revisar', 'descartar',
]);

function groupByCategory(items) {
  const map = new Map();
  for (const item of items) {
    const cat = item.meta.classification?.category ?? null;
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(item);
  }
  return map;
}

function formatItemLine(item) {
  const time = formatTime(item.meta.receivedAt);
  const caption = (item.meta.textCaption ?? '').slice(0, 80) || '(sin texto)';
  const words = item.meta.extraction?.words;
  const wordsStr = words ? ` · ${words}p` : '';
  const previewStr = item.preview ? ` — <i>${escapeHtml(item.preview.slice(0, 80))}…</i>` : '';
  return `• <code>${item.id.slice(0, 8)}</code> ${time} · ${escapeHtml(caption)}${wordsStr}${previewStr}`;
}

function formatTime(receivedAt) {
  try {
    const d = new Date(receivedAt);
    if (Number.isNaN(d.getTime())) return '?';
    // Spanish locale-style HH:mm
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  } catch {
    return '?';
  }
}

function escapeHtml(input) {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
