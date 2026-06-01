import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownSafe } from '../../../src/modules/markdown/safe-renderer.js';

describe('renderMarkdownSafe', () => {
  it('input vacío → ""', () => {
    assert.equal(renderMarkdownSafe(''), '');
    assert.equal(renderMarkdownSafe(null), '');
    assert.equal(renderMarkdownSafe(undefined), '');
  });

  it('escapa < > & " \' en el input antes de transformar', () => {
    const out = renderMarkdownSafe('<script>alert(1)</script>');
    assert.match(out, /&lt;script&gt;/);
    assert.doesNotMatch(out, /<script>/);
  });

  it('renderiza headers # ## ###', () => {
    assert.match(renderMarkdownSafe('# Título'), /<h1>Título<\/h1>/);
    assert.match(renderMarkdownSafe('## Sub'), /<h2>Sub<\/h2>/);
    assert.match(renderMarkdownSafe('### Sub2'), /<h3>Sub2<\/h3>/);
  });

  it('renderiza negrita y cursiva', () => {
    assert.match(renderMarkdownSafe('**bold**'), /<strong>bold<\/strong>/);
    assert.match(renderMarkdownSafe('__bold__'), /<strong>bold<\/strong>/);
    assert.match(renderMarkdownSafe('*ital*'), /<em>ital<\/em>/);
    assert.match(renderMarkdownSafe('_ital_'), /<em>ital<\/em>/);
  });

  it('renderiza inline code', () => {
    assert.match(renderMarkdownSafe('texto `var` más'), /<code>var<\/code>/);
  });

  it('renderiza bloques de código con lenguaje opcional', () => {
    const out = renderMarkdownSafe('```js\nconst x = 1;\n```');
    assert.match(out, /<pre><code data-lang="js">const x = 1;<\/code><\/pre>/);
  });

  it('los bloques de código no aplican transformaciones inline dentro', () => {
    const out = renderMarkdownSafe('```\n**no-bold** y `no-inline`\n```');
    assert.match(out, /<pre><code>\*\*no-bold\*\* y `no-inline`<\/code><\/pre>/);
  });

  it('listas no ordenadas con - y *', () => {
    const out = renderMarkdownSafe('- item a\n- item b');
    assert.match(out, /<ul>/);
    assert.match(out, /<li>item a<\/li>/);
    assert.match(out, /<li>item b<\/li>/);
    assert.match(out, /<\/ul>/);
  });

  it('listas ordenadas con números', () => {
    const out = renderMarkdownSafe('1. primero\n2. segundo');
    assert.match(out, /<ol>/);
    assert.match(out, /<li>primero<\/li>/);
    assert.match(out, /<li>segundo<\/li>/);
  });

  it('enlaces a esquemas seguros (http, https, mailto, relativos)', () => {
    const httpsOut = renderMarkdownSafe('[texto](https://example.com)');
    assert.match(httpsOut, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">texto<\/a>/);

    const mailOut = renderMarkdownSafe('[me](mailto:a@b.com)');
    assert.match(mailOut, /href="mailto:a@b.com"/);

    const relativeOut = renderMarkdownSafe('[hash](#sec1)');
    assert.match(relativeOut, /href="#sec1"/);
  });

  it('NO renderiza enlaces javascript: ni data: (XSS)', () => {
    const out = renderMarkdownSafe('[click](javascript:alert(1))');
    assert.doesNotMatch(out, /<a /);
    assert.match(out, /\[click\]/);  // queda como texto
  });

  it('párrafos: doble \\n separa, \\n simple → <br>', () => {
    const out = renderMarkdownSafe('línea uno\nlínea dos\n\nparrafo dos');
    assert.match(out, /<p>línea uno<br>línea dos<\/p>/);
    assert.match(out, /<p>parrafo dos<\/p>/);
  });

  it('mix realista: header + lista + negrita + enlace + código', () => {
    const md = '# Resumen\n\nPuntos **importantes**:\n\n- usa `npm test`\n- ver [docs](https://example.com)';
    const out = renderMarkdownSafe(md);
    assert.match(out, /<h1>Resumen<\/h1>/);
    assert.match(out, /<strong>importantes<\/strong>/);
    assert.match(out, /<code>npm test<\/code>/);
    assert.match(out, /<a href="https:\/\/example.com"/);
    assert.match(out, /<ul>/);
  });
});
