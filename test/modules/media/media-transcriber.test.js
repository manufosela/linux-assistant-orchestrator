import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaTranscriber, MediaError } from '../../../src/modules/media/media-transcriber.js';

function fakeWhisper({ text = 'transcripción de prueba' } = {}) {
  return { transcribe: async () => ({ text }) };
}

function fakeSummariser({ summary = 'resumen breve' } = {}) {
  return { summarise: async () => summary };
}

function fakeFfmpegOK() {
  return async (args) => {
    // Crea el fichero de salida vacío como haría ffmpeg.
    const outIdx = args.length - 1;
    await writeFile(args[outIdx], 'fake-mp3', 'utf8');
    return { code: 0, stderr: '' };
  };
}

async function makeFile(content = 'data', name = 'sample.mp3') {
  const dir = await mkdtemp(join(tmpdir(), 'media-test-'));
  const filePath = join(dir, name);
  await writeFile(filePath, content, 'utf8');
  return { filePath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('createMediaTranscriber', () => {
  it('requires whisperClient', () => {
    assert.throws(() => createMediaTranscriber({}), /whisperClient/);
  });

  it('filePath vacío → MediaError INVALID_ARGS', async () => {
    const t = createMediaTranscriber({ whisperClient: fakeWhisper() });
    await assert.rejects(t.transcribe(''), (e) => e instanceof MediaError && e.code === 'INVALID_ARGS');
  });

  it('fichero inexistente → MediaError NOT_FOUND', async () => {
    const t = createMediaTranscriber({ whisperClient: fakeWhisper() });
    await assert.rejects(t.transcribe('/no/existe.mp3'), (e) => e instanceof MediaError && e.code === 'NOT_FOUND');
  });

  it('audio mp3: no extrae con ffmpeg, llama whisper directo, sin resumen si withSummary=false', async () => {
    const { filePath, cleanup } = await makeFile('x', 'sample.mp3');
    let ffmpegCalled = false;
    const t = createMediaTranscriber({
      whisperClient: fakeWhisper({ text: 'hola mundo' }),
      runFfmpeg: async () => { ffmpegCalled = true; return { code: 0, stderr: '' }; },
    });
    const r = await t.transcribe(filePath, { withSummary: false });
    await cleanup();
    assert.equal(ffmpegCalled, false);
    assert.equal(r.transcript, 'hola mundo');
    assert.equal(r.summary, null);
    assert.equal(r.sourceKind, 'audio');
    assert.equal(r.audioExtracted, false);
  });

  it('vídeo mp4: extrae con ffmpeg, llama whisper sobre el audio, devuelve audioExtracted:true', async () => {
    const { filePath, cleanup } = await makeFile('vid-bytes', 'reunion.mp4');
    let ffmpegArgs = null;
    const t = createMediaTranscriber({
      whisperClient: fakeWhisper({ text: 'mensaje del vídeo' }),
      summariser: fakeSummariser({ summary: 'resumen breve' }),
      runFfmpeg: async (args) => {
        ffmpegArgs = args;
        await writeFile(args[args.length - 1], 'fake-mp3', 'utf8');
        return { code: 0, stderr: '' };
      },
    });
    const r = await t.transcribe(filePath);
    await cleanup();
    assert.equal(r.sourceKind, 'video');
    assert.equal(r.audioExtracted, true);
    assert.equal(r.transcript, 'mensaje del vídeo');
    assert.equal(r.summary, 'resumen breve');
    assert.ok(ffmpegArgs.includes('-i'));
    assert.ok(ffmpegArgs.some((a) => a.endsWith('.mp3')));
  });

  it('ffmpeg falla → MediaError FFMPEG_FAILED y limpia el workdir', async () => {
    const { filePath, cleanup } = await makeFile('vid', 'broken.mp4');
    const t = createMediaTranscriber({
      whisperClient: fakeWhisper(),
      runFfmpeg: async () => ({ code: 1, stderr: 'Invalid data found' }),
    });
    await assert.rejects(t.transcribe(filePath), (e) => e instanceof MediaError && e.code === 'FFMPEG_FAILED');
    await cleanup();
  });

  it('transcript vacío → MediaError EMPTY_TRANSCRIPT', async () => {
    const { filePath, cleanup } = await makeFile('x', 'silent.mp3');
    const t = createMediaTranscriber({ whisperClient: fakeWhisper({ text: '   ' }) });
    await assert.rejects(t.transcribe(filePath), (e) => e instanceof MediaError && e.code === 'EMPTY_TRANSCRIPT');
    await cleanup();
  });

  it('formato no soportado (.txt) → MediaError UNSUPPORTED_FORMAT', async () => {
    const { filePath, cleanup } = await makeFile('x', 'notes.txt');
    const t = createMediaTranscriber({ whisperClient: fakeWhisper() });
    await assert.rejects(t.transcribe(filePath), (e) => e instanceof MediaError && e.code === 'UNSUPPORTED_FORMAT');
    await cleanup();
  });

  it('fichero > maxBytes → MediaError TOO_LARGE (sin tocar whisper ni ffmpeg)', async () => {
    const { filePath, cleanup } = await makeFile('contenido suficiente', 'big.mp3');
    let whisperCalled = false;
    const t = createMediaTranscriber({
      whisperClient: { transcribe: async () => { whisperCalled = true; return { text: 'no' }; } },
      maxBytes: 5,  // muy bajo
    });
    await assert.rejects(t.transcribe(filePath), (e) => e instanceof MediaError && e.code === 'TOO_LARGE');
    assert.equal(whisperCalled, false);
    await cleanup();
  });

  it('withSummary=true sin summariser configurado → MediaError NO_SUMMARISER', async () => {
    const { filePath, cleanup } = await makeFile('x', 'audio.mp3');
    const t = createMediaTranscriber({ whisperClient: fakeWhisper({ text: 'hola' }) });
    await assert.rejects(t.transcribe(filePath, { withSummary: true }), (e) => e instanceof MediaError && e.code === 'NO_SUMMARISER');
    await cleanup();
  });

  it('chunkea correctamente cuando hay summariser y se pide resumen', async () => {
    const { filePath, cleanup } = await makeFile('x', 'audio.mp3');
    const t = createMediaTranscriber({
      whisperClient: fakeWhisper({ text: 'hola hola hola' }),
      summariser: fakeSummariser({ summary: 'OK' }),
    });
    const r = await t.transcribe(filePath, { withSummary: true });
    assert.equal(r.summary, 'OK');
    await cleanup();
  });
});
