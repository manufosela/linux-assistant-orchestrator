// IIFE wrapper sobre src/modules/markdown/safe-renderer.js.
// Mantén el cuerpo IDÉNTICO al del módulo ES o la UI y los tests Node divergen.
// El módulo ES es la fuente de verdad para los tests.
(function () {
  function renderMarkdownSafe(md) {
    if (typeof md !== 'string' || md.length === 0) return '';

    let html = escapeHtml(md);

    const codeBlocks = [];
    html = html.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
      const idx = codeBlocks.length;
      const langAttr = lang ? ` data-lang="${lang}"` : '';
      codeBlocks.push(`<pre><code${langAttr}>${code.replace(/\n$/, '')}</code></pre>`);
      return ` CODEBLOCK${idx} `;
    });

    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
    html = html.replace(/(^|[^_])_([^_\n]+)_([^_]|$)/g, '$1<em>$2</em>$3');

    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text, url) => {
      if (isSafeUrl(url)) {
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      }
      return match;
    });

    html = groupLists(html);

    html = html.split(/\n{2,}/).map((para) => {
      const trimmed = para.trim();
      if (trimmed === '') return '';
      if (/^<(h[1-6]|ul|ol|pre)\b/.test(trimmed) || trimmed.startsWith(' CODEBLOCK')) {
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    }).filter(Boolean).join('\n');

    html = html.replace(/ CODEBLOCK(\d+) /g, (_m, idx) => codeBlocks[Number(idx)] ?? '');

    return html;
  }

  function isSafeUrl(url) {
    if (url.startsWith('/') || url.startsWith('#') || url.startsWith('?')) return true;
    return /^(https?:|mailto:)/i.test(url);
  }

  function groupLists(html) {
    const lines = html.split('\n');
    const out = [];
    let listType = null;
    function closeList() {
      if (listType) { out.push(`</${listType}>`); listType = null; }
    }
    for (const line of lines) {
      const ulMatch = line.match(/^[-*]\s+(.*)$/);
      const olMatch = line.match(/^\d+\.\s+(.*)$/);
      if (ulMatch) {
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        out.push(`<li>${ulMatch[1]}</li>`);
      } else if (olMatch) {
        if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
        out.push(`<li>${olMatch[1]}</li>`);
      } else {
        closeList();
        out.push(line);
      }
    }
    closeList();
    return out.join('\n');
  }

  function escapeHtml(input) {
    return String(input)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  window.luisMarkdown = { render: renderMarkdownSafe };
})();
