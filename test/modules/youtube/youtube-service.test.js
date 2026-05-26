import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createYoutubeService,
  chunkText,
} from '../../../src/modules/youtube/youtube-service.js';
import { YoutubeError } from '../../../src/modules/youtube/ytdlp-runner.js';

function stubs({
  subsResult = null,
  audioResult = null,
  whisperText = '',
  summaryText = 'RESUMEN',
} = {}) {
  let cleanupCalls = 0;
  const calls = { fetchSubtitles: 0, fetchAudio: 0, transcribe: 0, generateText: 0, generateTextOps: [] };
  const subtitleFetcher = {
    fetchSubtitles: async () => { calls.fetchSubtitles += 1; return subsResult; },
  };
  const audioFetcher = {
    fetchAudio: async () => {
      calls.fetchAudio += 1;
      return {
        ...audioResult,
        cleanup: async () => { cleanupCalls += 1; },
      };
    },
  };
  const whisperClient = {
    transcribe: async () => { calls.transcribe += 1; return { text: whisperText }; },
  };
  const llmService = {
    generateText: async (_prompt, opts) => {
      calls.generateText += 1;
      calls.generateTextOps.push(opts?.operation ?? null);
      return summaryText;
    },
  };
  return { subtitleFetcher, audioFetcher, whisperClient, llmService, calls, getCleanupCalls: () => cleanupCalls };
}

describe('createYoutubeService', () => {
  it('falta dependencia → throw', () => {
    assert.throws(() => createYoutubeService({}));
  });

  it('subtítulos disponibles: usa fast path, no llama a audio ni whisper', async () => {
    const s = stubs({
      subsResult: { videoId: 'v1', title: 'T', lang: 'es', text: 'transcripción de subs' },
    });
    const svc = createYoutubeService(s);
    const out = await svc.processVideo('https://youtu.be/v1');
    assert.equal(out.source, 'subtitles');
    assert.equal(out.transcript, 'transcripción de subs');
    assert.equal(out.summary, 'RESUMEN');
    assert.equal(s.calls.fetchSubtitles, 1);
    assert.equal(s.calls.fetchAudio, 0);
    assert.equal(s.calls.transcribe, 0);
    assert.equal(s.calls.generateText, 1);
  });

  it('sin subtítulos: cae a audio + whisper y limpia el audio', async () => {
    const s = stubs({
      subsResult: null,
      audioResult: { audioPath: '/tmp/x.mp3', videoId: 'v2', title: 'T2', durationSec: 120 },
      whisperText: 'transcripción whisper',
    });
    const svc = createYoutubeService(s);
    const out = await svc.processVideo('https://youtu.be/v2');
    assert.equal(out.source, 'whisper');
    assert.equal(out.transcript, 'transcripción whisper');
    assert.equal(out.durationSec, 120);
    assert.equal(s.calls.transcribe, 1);
    assert.equal(s.getCleanupCalls(), 1);
  });

  it('whisper falla: el audio se limpia igualmente (finally)', async () => {
    const s = stubs({
      subsResult: null,
      audioResult: { audioPath: '/tmp/x.mp3', videoId: 'v3', title: 'T3', durationSec: 10 },
    });
    s.whisperClient.transcribe = async () => { throw new Error('whisper down'); };
    const svc = createYoutubeService(s);
    await assert.rejects(svc.processVideo('https://youtu.be/v3'), /whisper down/);
    assert.equal(s.getCleanupCalls(), 1);
  });

  it('transcript vacío → YoutubeError EMPTY_TRANSCRIPT', async () => {
    const s = stubs({ subsResult: { videoId: 'v', title: null, lang: 'es', text: '' } });
    const svc = createYoutubeService(s);
    await assert.rejects(
      svc.processVideo('https://youtu.be/v'),
      (err) => err instanceof YoutubeError && err.code === 'EMPTY_TRANSCRIPT',
    );
  });

  it('withSummary=false: no invoca al LLM, devuelve summary=null', async () => {
    const s = stubs({ subsResult: { videoId: 'v', title: null, lang: 'es', text: 'algo' } });
    const svc = createYoutubeService(s);
    const out = await svc.processVideo('https://youtu.be/v', { withSummary: false });
    assert.equal(out.summary, null);
    assert.equal(s.calls.generateText, 0);
  });

  it('transcript largo: aplica chunking (chunks parciales + meta-resumen)', async () => {
    const long = 'frase. '.repeat(3000);  // ~21000 chars
    const s = stubs({ subsResult: { videoId: 'v', title: 'T', lang: 'es', text: long } });
    const svc = createYoutubeService({ ...s, summaryChunkChars: 8000 });
    const out = await svc.processVideo('https://youtu.be/v');
    assert.ok(s.calls.generateText > 1, 'debe llamar al LLM más de una vez al chunkear');
    assert.ok(s.calls.generateTextOps.includes('summary-chunk'));
    assert.ok(s.calls.generateTextOps.includes('summary-final'));
    assert.equal(out.summary, 'RESUMEN');
  });

  it('language por defecto = es; opcional override', async () => {
    let capturedLang = null;
    const s = stubs({ subsResult: null, audioResult: { audioPath: '/x', videoId: 'v', title: 't', durationSec: 1 }, whisperText: 'x' });
    s.whisperClient.transcribe = async (_p, opts) => { capturedLang = opts?.language; return { text: 'x' }; };
    const svc = createYoutubeService(s);
    await svc.processVideo('https://youtu.be/v', { language: 'en' });
    assert.equal(capturedLang, 'en');
  });
});

describe('chunkText', () => {
  it('texto corto: un solo chunk', () => {
    assert.deepEqual(chunkText('hola mundo', 100), ['hola mundo']);
  });

  it('respeta fin de frase si está dentro del 50% final del chunk', () => {
    const text = 'Frase uno corta. Frase dos. ' + 'X'.repeat(50);
    const chunks = chunkText(text, 40);
    assert.ok(chunks[0].endsWith('.'), `esperado terminar con punto, got: "${chunks[0]}"`);
    assert.ok(chunks.length >= 2);
  });

  it('corta al límite si no hay fin de frase cerca', () => {
    const text = 'X'.repeat(200);
    const chunks = chunkText(text, 50);
    assert.equal(chunks.length, 4);
    assert.equal(chunks[0].length, 50);
  });

  it('descarta chunks vacíos tras trim', () => {
    const chunks = chunkText('hola.   .   mundo', 1000);
    assert.equal(chunks.length, 1);
  });
});
