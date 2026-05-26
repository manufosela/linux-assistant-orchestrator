import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createYoutubeAudioFetcher,
  YoutubeError,
} from '../../../src/modules/youtube/youtube-audio-fetcher.js';

function makeFakeRunner({ audioFiles = {}, code = 0, stderr = '', stdout = 'vid123\tMi título\t123.45\n' } = {}) {
  return async function fakeRun({ args }) {
    const oIdx = args.indexOf('-o');
    if (oIdx >= 0 && code === 0) {
      const template = args[oIdx + 1];
      const workdir = template.replace(/\/%\(id\)s\.%\(ext\)s$/, '');
      for (const [name, content] of Object.entries(audioFiles)) {
        await writeFile(join(workdir, name), content, 'utf8');
      }
    }
    return { code, stdout, stderr };
  };
}

describe('createYoutubeAudioFetcher', () => {
  it('URL vacía → YoutubeError INVALID_ARGS', async () => {
    const fetcher = createYoutubeAudioFetcher({ runCommand: makeFakeRunner() });
    await assert.rejects(
      fetcher.fetchAudio(''),
      (err) => err instanceof YoutubeError && err.code === 'INVALID_ARGS',
    );
  });

  it('vídeo válido: devuelve audioPath + metadata + cleanup', async () => {
    const fetcher = createYoutubeAudioFetcher({
      runCommand: makeFakeRunner({ audioFiles: { 'vid123.mp3': 'fake-audio-bytes' } }),
    });
    const result = await fetcher.fetchAudio('https://youtu.be/vid123');
    assert.ok(result.audioPath.endsWith('vid123.mp3'));
    assert.equal(result.videoId, 'vid123');
    assert.equal(result.title, 'Mi título');
    assert.equal(result.durationSec, 123.45);
    assert.equal(typeof result.cleanup, 'function');
    // El fichero existe en disco antes de cleanup
    const st = await stat(result.audioPath);
    assert.ok(st.isFile());
    // cleanup borra el workdir
    await result.cleanup();
    await assert.rejects(stat(result.audioPath), /ENOENT/);
  });

  it('si yt-dlp no produce audio → YoutubeError NO_AUDIO y limpia workdir', async () => {
    const fetcher = createYoutubeAudioFetcher({
      runCommand: makeFakeRunner({ audioFiles: {}, stdout: 'vid123\tFoo\t10\n' }),
    });
    await assert.rejects(
      fetcher.fetchAudio('https://youtu.be/vid123'),
      (err) => err instanceof YoutubeError && err.code === 'NO_AUDIO',
    );
  });

  it('vídeo no disponible → YoutubeError UNAVAILABLE y limpia workdir', async () => {
    let capturedWorkdir = null;
    const fetcher = createYoutubeAudioFetcher({
      runCommand: async ({ args }) => {
        const oIdx = args.indexOf('-o');
        capturedWorkdir = args[oIdx + 1].replace(/\/%\(id\)s\.%\(ext\)s$/, '');
        return { code: 1, stdout: '', stderr: 'ERROR: Video unavailable' };
      },
    });
    await assert.rejects(
      fetcher.fetchAudio('https://youtu.be/dead'),
      (err) => err instanceof YoutubeError && err.code === 'UNAVAILABLE',
    );
    await assert.rejects(rm(capturedWorkdir, { recursive: true }), /ENOENT/);
  });

  it('durationSec inválida en stdout → null (no NaN)', async () => {
    const fetcher = createYoutubeAudioFetcher({
      runCommand: makeFakeRunner({
        audioFiles: { 'vid123.mp3': 'x' },
        stdout: 'vid123\tT\tNA\n',
      }),
    });
    const result = await fetcher.fetchAudio('https://youtu.be/vid123');
    assert.equal(result.durationSec, null);
    await result.cleanup();
  });

  it('audioFormat personalizado (m4a) busca ficheros con esa extensión', async () => {
    const fetcher = createYoutubeAudioFetcher({
      audioFormat: 'm4a',
      runCommand: makeFakeRunner({ audioFiles: { 'vid123.m4a': 'x' } }),
    });
    const result = await fetcher.fetchAudio('https://youtu.be/vid123');
    assert.ok(result.audioPath.endsWith('.m4a'));
    await result.cleanup();
  });
});
