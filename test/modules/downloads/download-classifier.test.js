import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDownloadClassifier } from '../../../src/modules/downloads/download-classifier.js';

function fakeLlm(reply) {
  return {
    calls: [],
    async generateText(prompt, meta) {
      this.calls.push({ prompt, meta });
      return typeof reply === 'function' ? reply(prompt, meta) : reply;
    },
  };
}

describe('createDownloadClassifier — heuristic shortcuts (no LLM)', () => {
  it('vídeo con tag de fansub → ANIME, confidence alta, source heuristic', async () => {
    const llm = fakeLlm('NUNCA');
    const c = createDownloadClassifier({ llmService: llm });
    const r = await c.classify({ filename: '[SubsPlease] Spy x Family - 12 (1080p).mkv', sizeBytes: 1000000000 });
    assert.equal(r.category, 'ANIME');
    assert.ok(r.confidence >= 0.85);
    assert.equal(r.source, 'heuristic');
    assert.equal(llm.calls.length, 0, 'no debe llamar al LLM');
  });

  it('vídeo con S01E01 → SERIES, no llama al LLM', async () => {
    const llm = fakeLlm('NUNCA');
    const c = createDownloadClassifier({ llmService: llm });
    const r = await c.classify({ filename: 'Severance.S02E07.1080p.WEB-DL.mkv' });
    assert.equal(r.category, 'SERIES');
    assert.equal(r.source, 'heuristic');
    assert.equal(llm.calls.length, 0);
  });

  it('vídeo con 1x05 → SERIES', async () => {
    const llm = fakeLlm('NUNCA');
    const c = createDownloadClassifier({ llmService: llm });
    const r = await c.classify({ filename: 'TheBoys.1x05.mp4' });
    assert.equal(r.category, 'SERIES');
  });

  it('libro con extensión clara (epub) → LIBROS, no llama al LLM', async () => {
    const llm = fakeLlm('NUNCA');
    const c = createDownloadClassifier({ llmService: llm });
    const r = await c.classify({ filename: 'Sapiens.epub' });
    assert.equal(r.category, 'LIBROS');
    assert.equal(llm.calls.length, 0);
  });

  it('cómic con extensión cbz → COMICS, no llama al LLM', async () => {
    const llm = fakeLlm('NUNCA');
    const c = createDownloadClassifier({ llmService: llm });
    const r = await c.classify({ filename: 'Watchmen.001.cbz' });
    assert.equal(r.category, 'COMICS');
    assert.equal(llm.calls.length, 0);
  });

  it('audio largo (>30 min) → AUDIOLIBROS sin LLM', async () => {
    const llm = fakeLlm('NUNCA');
    const c = createDownloadClassifier({ llmService: llm });
    const r = await c.classify({ filename: 'Antolina Ortiz - Capítulo 1.m4a', durationSec: 3600 });
    assert.equal(r.category, 'AUDIOLIBROS');
    assert.equal(llm.calls.length, 0);
  });
});

describe('createDownloadClassifier — fallback al LLM', () => {
  it('vídeo sin marca clara → consulta al LLM y respeta su categoría', async () => {
    const llm = fakeLlm('{"category":"ANIME","confidence":0.92,"rationale":"Nombre japonés romanizado típico de OVA"}');
    const c = createDownloadClassifier({ llmService: llm });
    const r = await c.classify({ filename: 'Akira.1988.1080p.BluRay.mkv', sizeBytes: 5_000_000_000 });
    assert.equal(r.source, 'llm');
    assert.equal(r.category, 'ANIME');
    assert.equal(llm.calls.length, 1);
  });

  it('pdf pequeño → consulta al LLM (heurística devuelve confidence bajo)', async () => {
    const llm = fakeLlm('{"category":"LIBROS","confidence":0.85,"rationale":"PDF aunque pequeño parece ser un libro corto"}');
    const c = createDownloadClassifier({ llmService: llm });
    const r = await c.classify({ filename: 'Manualito.pdf', sizeBytes: 300_000 });
    assert.equal(r.source, 'llm');
    assert.equal(r.category, 'LIBROS');
  });

  it('audio corto → consulta al LLM (heurística baja); si el LLM dice OTHER respetamos', async () => {
    const llm = fakeLlm('{"category":"OTHER","confidence":0.6,"rationale":"Canción de 3 min"}');
    const c = createDownloadClassifier({ llmService: llm });
    const r = await c.classify({ filename: 'Bad Bunny - Tití me preguntó.mp3', durationSec: 200 });
    assert.equal(r.category, 'OTHER');
    assert.equal(r.source, 'llm');
  });

  it('LLM devuelve JSON envuelto en ```json … ``` → se parsea correctamente', async () => {
    const llm = fakeLlm('```json\n{"category":"SERIES","confidence":0.8,"rationale":"x"}\n```');
    const c = createDownloadClassifier({ llmService: llm });
    const r = await c.classify({ filename: 'algo-raro.mkv' });
    assert.equal(r.category, 'SERIES');
  });

  it('LLM devuelve categoría inválida + heurística OTHER → OTHER final', async () => {
    const llm = fakeLlm('{"category":"VIDEOS","confidence":0.8,"rationale":"x"}');
    const c = createDownloadClassifier({ llmService: llm });
    // pdf pequeño tiene heurística OTHER, así que no hay fallback útil
    const r = await c.classify({ filename: 'doc.pdf', sizeBytes: 100_000 });
    assert.equal(r.category, 'OTHER');
  });

  it('LLM devuelve texto NO json + heurística OTHER → OTHER final', async () => {
    const llm = fakeLlm('No estoy seguro, podría ser cualquier cosa.');
    const c = createDownloadClassifier({ llmService: llm });
    const r = await c.classify({ filename: 'doc.pdf', sizeBytes: 100_000 });
    assert.equal(r.category, 'OTHER');
  });

  it('LLM categoría inválida + heurística tenía pista → usamos la heurística', async () => {
    const llm = fakeLlm('{"category":"VIDEOS","confidence":0.8,"rationale":"x"}');
    const c = createDownloadClassifier({ llmService: llm });
    const r = await c.classify({ filename: 'pelicula.mkv' });
    assert.equal(r.category, 'PELICULAS');
    assert.equal(r.source, 'heuristic-fallback');
  });

  it('LLM lanza error y heurística no era OTHER → fallback a heurística', async () => {
    const llm = {
      async generateText() { throw new Error('LLM caído'); },
    };
    const c = createDownloadClassifier({ llmService: llm });
    // Un vídeo sin marca tiene heurística PELICULAS confidence 0.55
    const r = await c.classify({ filename: 'algo.mkv' });
    assert.equal(r.category, 'PELICULAS');
    assert.equal(r.source, 'heuristic-fallback');
  });

  it('LLM lanza error y heurística también es OTHER → devuelve OTHER', async () => {
    const llm = {
      async generateText() { throw new Error('LLM caído'); },
    };
    const c = createDownloadClassifier({ llmService: llm });
    // PDF pequeño da heurística OTHER → no hay fallback útil
    const r = await c.classify({ filename: 'doc.pdf', sizeBytes: 100_000 });
    assert.equal(r.category, 'OTHER');
    assert.equal(r.source, 'llm');
  });

  it('clampea confidence fuera de rango [0,1]', async () => {
    const llm = fakeLlm('{"category":"SERIES","confidence":2.5,"rationale":"x"}');
    const c = createDownloadClassifier({ llmService: llm });
    const r = await c.classify({ filename: 'algo.mkv' });
    assert.equal(r.confidence, 1);
  });
});

describe('createDownloadClassifier — validación de entrada', () => {
  it('rechaza filename vacío', async () => {
    const c = createDownloadClassifier({ llmService: fakeLlm('') });
    await assert.rejects(c.classify({ filename: '' }), /filename/);
    await assert.rejects(c.classify({}), /filename/);
  });

  it('rechaza construcción sin llmService', () => {
    assert.throws(() => createDownloadClassifier({}), /llmService/);
  });

  it('deriva extensión del filename si no se pasa explícita', async () => {
    const llm = fakeLlm('NUNCA');
    const c = createDownloadClassifier({ llmService: llm });
    const r = await c.classify({ filename: 'mi-libro.epub' });
    assert.equal(r.category, 'LIBROS');
  });
});
