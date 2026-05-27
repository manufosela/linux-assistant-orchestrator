import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createYoutubeSubtitleFetcher,
  YoutubeError,
} from '../../../src/modules/youtube/youtube-subtitle-fetcher.js';

const SRT_FIXTURE = [
  '1',
  '00:00:01,000 --> 00:00:03,000',
  'hola mundo',
  '',
].join('\n');

/**
 * Stub de runCommand que, en lugar de invocar yt-dlp, escribe ficheros .srt
 * en el workdir que yt-dlp habría usado (extraído del flag -o de los args)
 * y devuelve un stdout simulado.
 */
function makeFakeRunner({ srtFiles = {}, code = 0, stderr = '', stdout = 'vid123\tMi título\n' } = {}) {
  return async function fakeRun({ args }) {
    const oIdx = args.indexOf('-o');
    if (oIdx >= 0) {
      const template = args[oIdx + 1];
      const workdir = template.replace(/\/%\(id\)s$/, '');
      for (const [name, content] of Object.entries(srtFiles)) {
        await writeFile(join(workdir, name), content, 'utf8');
      }
    }
    return { code, stdout, stderr };
  };
}

describe('createYoutubeSubtitleFetcher', () => {
  it('URL vacía → YoutubeError INVALID_ARGS', async () => {
    const fetcher = createYoutubeSubtitleFetcher({ runCommand: makeFakeRunner() });
    await assert.rejects(fetcher.fetchSubtitles(''), (err) => err instanceof YoutubeError && err.code === 'INVALID_ARGS');
  });

  it('vídeo con subtítulos en español devuelve texto + metadata', async () => {
    const fetcher = createYoutubeSubtitleFetcher({
      runCommand: makeFakeRunner({ srtFiles: { 'vid123.es.srt': SRT_FIXTURE } }),
    });
    const result = await fetcher.fetchSubtitles('https://youtu.be/vid123');
    assert.deepEqual(result, {
      videoId: 'vid123',
      title: 'Mi título',
      lang: 'es',
      text: 'hola mundo',
    });
  });

  it('respeta orden de preferencia de idiomas (es antes que en)', async () => {
    const fetcher = createYoutubeSubtitleFetcher({
      preferredLangs: ['es', 'en'],
      runCommand: makeFakeRunner({
        srtFiles: {
          'vid123.en.srt': 'should not be picked',
          'vid123.es.srt': SRT_FIXTURE,
        },
      }),
    });
    const result = await fetcher.fetchSubtitles('https://youtu.be/vid123');
    assert.equal(result.lang, 'es');
    assert.equal(result.text, 'hola mundo');
  });

  it('si solo hay subs en inglés, cae al siguiente idioma preferido', async () => {
    const fetcher = createYoutubeSubtitleFetcher({
      preferredLangs: ['es', 'en'],
      runCommand: makeFakeRunner({ srtFiles: { 'vid123.en.srt': SRT_FIXTURE } }),
    });
    const result = await fetcher.fetchSubtitles('https://youtu.be/vid123');
    assert.equal(result.lang, 'en');
  });

  it('sin subtítulos disponibles devuelve null', async () => {
    const fetcher = createYoutubeSubtitleFetcher({ runCommand: makeFakeRunner({ srtFiles: {} }) });
    const result = await fetcher.fetchSubtitles('https://youtu.be/vid123');
    assert.equal(result, null);
  });

  it('vídeo no disponible → YoutubeError UNAVAILABLE', async () => {
    const fetcher = createYoutubeSubtitleFetcher({
      runCommand: makeFakeRunner({ code: 1, stderr: 'ERROR: Video unavailable' }),
    });
    await assert.rejects(
      fetcher.fetchSubtitles('https://youtu.be/dead'),
      (err) => err instanceof YoutubeError && err.code === 'UNAVAILABLE',
    );
  });

  it('vídeo privado → YoutubeError PRIVATE', async () => {
    const fetcher = createYoutubeSubtitleFetcher({
      runCommand: makeFakeRunner({ code: 1, stderr: 'ERROR: Private video. Sign in if you have access' }),
    });
    await assert.rejects(
      fetcher.fetchSubtitles('https://youtu.be/priv'),
      (err) => err instanceof YoutubeError && err.code === 'PRIVATE',
    );
  });

  it('URL inválida → YoutubeError INVALID_URL', async () => {
    const fetcher = createYoutubeSubtitleFetcher({
      runCommand: makeFakeRunner({ code: 1, stderr: 'ERROR: not_a_url is not a valid URL' }),
    });
    await assert.rejects(
      fetcher.fetchSubtitles('not_a_url'),
      (err) => err instanceof YoutubeError && err.code === 'INVALID_URL',
    );
  });

  it('limpia el workdir aunque falle (no deja basura en /tmp)', async () => {
    const captured = [];
    const fetcher = createYoutubeSubtitleFetcher({
      runCommand: async ({ args }) => {
        const oIdx = args.indexOf('-o');
        const workdir = args[oIdx + 1].replace(/\/%\(id\)s$/, '');
        captured.push(workdir);
        return { code: 1, stdout: '', stderr: 'ERROR: Video unavailable' };
      },
    });
    await assert.rejects(fetcher.fetchSubtitles('https://youtu.be/x'));
    assert.equal(captured.length, 1);
    await assert.rejects(rm(captured[0], { recursive: true }), /ENOENT/);
  });

  it('extrae lang de filenames con subetiqueta (en-US)', async () => {
    const fetcher = createYoutubeSubtitleFetcher({
      preferredLangs: ['en'],
      runCommand: makeFakeRunner({ srtFiles: { 'vid123.en-US.srt': SRT_FIXTURE } }),
    });
    const result = await fetcher.fetchSubtitles('https://youtu.be/vid123');
    assert.equal(result.lang, 'en-US');
  });
});

describe('createYoutubeSubtitleFetcher — integración con tmpdir real', () => {
  it('lee correctamente el .srt que el runner deja en el workdir efímero', async () => {
    // Sanity check: el flow completo (mkdtemp + readdir + readFile + parser).
    const workdirsCreated = [];
    const fetcher = createYoutubeSubtitleFetcher({
      runCommand: async ({ args }) => {
        const oIdx = args.indexOf('-o');
        const workdir = args[oIdx + 1].replace(/\/%\(id\)s$/, '');
        workdirsCreated.push(workdir);
        await writeFile(join(workdir, 'vid123.es.srt'), SRT_FIXTURE, 'utf8');
        return { code: 0, stdout: 'vid123\tFoo\n', stderr: '' };
      },
    });
    const result = await fetcher.fetchSubtitles('https://youtu.be/vid123');
    assert.equal(result.text, 'hola mundo');
    // El workdir debe haberse limpiado al final
    assert.equal(workdirsCreated.length, 1);
    await assert.rejects(
      (async () => {
        const _ = await import('node:fs/promises').then((m) => m.stat(workdirsCreated[0]));
      })(),
      /ENOENT/,
    );
  });

  it.skip('e2e: yt-dlp real (deshabilitado por defecto: requiere red e instalación)', async () => {
    // Para correrlo manualmente: cambia .skip por nada. Necesita yt-dlp en PATH.
    const fetcher = createYoutubeSubtitleFetcher();
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const result = await fetcher.fetchSubtitles(url);
    assert.ok(result === null || typeof result.text === 'string');
  });
});

// suprimir warning de tmpdir no usado en helpers
void mkdtemp;
void tmpdir;
