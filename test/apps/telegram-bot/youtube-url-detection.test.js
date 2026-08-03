import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isYoutubeUrl, youtubeProgressText, sanitizeFilename } from '../../../src/apps/telegram-bot/telegram-message-handler.js';

describe('isYoutubeUrl (LUI-BUG-0012)', () => {
  it('detecta los formatos de YouTube', () => {
    const yes = [
      'https://youtu.be/AZ8ReGw2Qqs',
      'http://youtu.be/AZ8ReGw2Qqs',
      'youtu.be/AZ8ReGw2Qqs',
      'https://www.youtube.com/watch?v=AZ8ReGw2Qqs',
      'https://youtube.com/watch?v=AZ8ReGw2Qqs&t=30',
      'https://m.youtube.com/watch?v=AZ8ReGw2Qqs',
      'https://www.youtube.com/shorts/abc123',
      'https://www.youtube.com/embed/abc123',
      'https://www.youtube.com/live/abc123',
    ];
    for (const url of yes) {
      assert.equal(isYoutubeUrl(url), true, `debería detectar: ${url}`);
    }
  });

  it('NO detecta URLs que no son de YouTube', () => {
    const no = [
      'https://elpais.com/articulo-sobre-youtube',   // "youtube" en el path, no el dominio
      'https://vimeo.com/12345',
      'https://example.com/watch?v=abc',
      'https://myyoutube.com/watch?v=abc',            // dominio parecido, no es youtube.com
      'texto sin url',
      '',
      null,
      undefined,
    ];
    for (const url of no) {
      assert.equal(isYoutubeUrl(url), false, `NO debería detectar: ${url}`);
    }
  });
});

describe('youtubeProgressText (LUI-TSK-0090)', () => {
  const U = 'https://youtu.be/x';
  it('mapea cada etapa a un texto', () => {
    assert.match(youtubeProgressText(U, { stage: 'subtitles' }), /subtítulos/i);
    assert.match(youtubeProgressText(U, { stage: 'audio' }), /audio/i);
    assert.match(youtubeProgressText(U, { stage: 'transcribing' }), /Transcribiendo/i);
    assert.match(youtubeProgressText(U, { stage: 'summarising', index: 3, total: 14 }), /3\/14/);
    assert.match(youtubeProgressText(U, { stage: 'summarising', finalising: true }), /final/i);
  });
  it('incluye la URL', () => {
    assert.match(youtubeProgressText(U, { stage: 'audio' }), /youtu\.be\/x/);
  });
});

describe('sanitizeFilename (LUI-TSK-0091)', () => {
  it('quita caracteres prohibidos y colapsa espacios', () => {
    assert.equal(sanitizeFilename('Mi vídeo: cosas / raras?*'), 'Mi vídeo cosas raras');
  });
  it('usa el fallback si queda vacío', () => {
    assert.equal(sanitizeFilename('   ', 'video'), 'video');
    assert.equal(sanitizeFilename(null), 'video');
  });
  it('acota a 80 chars', () => {
    assert.ok(sanitizeFilename('a'.repeat(200)).length <= 80);
  });
});
