import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { srtToPlainText } from '../../../src/modules/youtube/subtitle-parser.js';

describe('srtToPlainText', () => {
  it('entrada vacía → string vacío', () => {
    assert.equal(srtToPlainText(''), '');
    assert.equal(srtToPlainText(null), '');
    assert.equal(srtToPlainText(undefined), '');
  });

  it('elimina índices de cue y timings, conserva el texto', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:03,000',
      'Hola, bienvenidos',
      '',
      '2',
      '00:00:03,500 --> 00:00:05,000',
      'al canal',
      '',
    ].join('\n');
    assert.equal(srtToPlainText(srt), 'Hola, bienvenidos al canal');
  });

  it('quita tags HTML simples (<i>, <b>, <font>)', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:03,000',
      '<i>Cursiva</i> y <b>negrita</b>',
      '',
      '2',
      '00:00:03,500 --> 00:00:05,000',
      '<font color="white">color</font>',
      '',
    ].join('\n');
    assert.equal(srtToPlainText(srt), 'Cursiva y negrita color');
  });

  it('deduplica líneas consecutivas idénticas (típico de auto-subs)', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:03,000',
      'hola',
      '',
      '2',
      '00:00:03,500 --> 00:00:05,000',
      'hola',
      '',
      '3',
      '00:00:05,500 --> 00:00:07,000',
      'mundo',
      '',
    ].join('\n');
    assert.equal(srtToPlainText(srt), 'hola mundo');
  });

  it('soporta cues multilínea', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:03,000',
      'primera línea',
      'segunda línea',
      '',
    ].join('\n');
    assert.equal(srtToPlainText(srt), 'primera línea segunda línea');
  });

  it('ignora BOM al inicio', () => {
    const srt = '﻿1\n00:00:01,000 --> 00:00:03,000\ntexto\n';
    assert.equal(srtToPlainText(srt), 'texto');
  });

  it('colapsa whitespace extra', () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,000\nhola   mundo\n';
    assert.equal(srtToPlainText(srt), 'hola mundo');
  });

  it('un fichero con solo timings y vacío devuelve string vacío', () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,000\n\n2\n00:00:03,500 --> 00:00:05,000\n\n';
    assert.equal(srtToPlainText(srt), '');
  });
});
