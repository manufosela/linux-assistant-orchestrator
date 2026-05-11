import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createThinkingIndicator } from '../../../src/apps/telegram-bot/thinking-indicator.js';

function createBotStub({ editShouldFail = false } = {}) {
  const calls = {
    sendMessage: [],
    editMessageText: [],
    deleteMessage: [],
  };

  let nextMessageId = 100;

  const bot = {
    async sendMessage(chatId, text, opts) {
      calls.sendMessage.push({ chatId, text, opts });
      return { message_id: nextMessageId++ };
    },
    async editMessageText(text, opts) {
      calls.editMessageText.push({ text, opts });
      if (editShouldFail) {
        throw new Error('Bad Request: message is not modified');
      }
    },
    async deleteMessage(chatId, messageId) {
      calls.deleteMessage.push({ chatId, messageId });
    },
  };

  return { bot, calls };
}

describe('createThinkingIndicator', () => {
  let bot;
  let calls;

  beforeEach(() => {
    ({ bot, calls } = createBotStub());
  });

  it('sends the placeholder text on creation', async () => {
    const indicator = await createThinkingIndicator(bot, 42);
    assert.equal(calls.sendMessage.length, 1);
    assert.equal(calls.sendMessage[0].chatId, 42);
    assert.equal(calls.sendMessage[0].text, '⏳ Pensando…');
    assert.equal(indicator.messageId, 100);
  });

  it('uses a custom placeholder when provided', async () => {
    await createThinkingIndicator(bot, 42, { text: '🔎 Buscando…' });
    assert.equal(calls.sendMessage[0].text, '🔎 Buscando…');
  });

  it('passes parseMode through to the initial message', async () => {
    await createThinkingIndicator(bot, 42, { parseMode: 'HTML' });
    assert.deepEqual(calls.sendMessage[0].opts, { parse_mode: 'HTML' });
  });

  it('finish() edits the placeholder with the final text', async () => {
    const indicator = await createThinkingIndicator(bot, 42);
    await indicator.finish('Resultado final');

    assert.equal(calls.editMessageText.length, 1);
    assert.equal(calls.editMessageText[0].text, 'Resultado final');
    assert.deepEqual(calls.editMessageText[0].opts, {
      chat_id: 42,
      message_id: 100,
    });
    assert.equal(calls.sendMessage.length, 1); // only the placeholder
    assert.equal(calls.deleteMessage.length, 0);
  });

  it('finish() forwards extra options like parse_mode to editMessageText', async () => {
    const indicator = await createThinkingIndicator(bot, 42);
    await indicator.finish('<b>x</b>', { parse_mode: 'HTML' });
    assert.equal(calls.editMessageText[0].opts.parse_mode, 'HTML');
  });

  it('finish() is idempotent — second call is a no-op', async () => {
    const indicator = await createThinkingIndicator(bot, 42);
    await indicator.finish('A');
    await indicator.finish('B');
    assert.equal(calls.editMessageText.length, 1);
    assert.equal(calls.editMessageText[0].text, 'A');
  });

  it('falls back to send + delete when editMessageText fails', async () => {
    ({ bot, calls } = createBotStub({ editShouldFail: true }));
    const indicator = await createThinkingIndicator(bot, 42);
    await indicator.finish('Final');

    assert.equal(calls.editMessageText.length, 1);
    assert.equal(calls.sendMessage.length, 2); // placeholder + fallback
    assert.equal(calls.sendMessage[1].text, 'Final');
    assert.equal(calls.deleteMessage.length, 1);
    assert.equal(calls.deleteMessage[0].messageId, 100);
  });

  it('cancel() deletes the placeholder', async () => {
    const indicator = await createThinkingIndicator(bot, 42);
    await indicator.cancel();
    assert.equal(calls.deleteMessage.length, 1);
    assert.equal(calls.deleteMessage[0].chatId, 42);
    assert.equal(calls.deleteMessage[0].messageId, 100);
  });

  it('cancel() is idempotent and blocks subsequent finish()', async () => {
    const indicator = await createThinkingIndicator(bot, 42);
    await indicator.cancel();
    await indicator.finish('No deberia salir');
    assert.equal(calls.deleteMessage.length, 1);
    assert.equal(calls.editMessageText.length, 0);
  });

  it('does not throw when deleteMessage fails during cancel', async () => {
    bot.deleteMessage = async () => {
      throw new Error('Bot was kicked');
    };
    const indicator = await createThinkingIndicator(bot, 42);
    await assert.doesNotReject(indicator.cancel());
  });

  it('does not throw when the fallback sendMessage fails too', async () => {
    ({ bot, calls } = createBotStub({ editShouldFail: true }));
    bot.sendMessage = async (chatId, text) => {
      if (text === 'Final') throw new Error('Network error');
      calls.sendMessage.push({ chatId, text });
      return { message_id: 100 };
    };
    const indicator = await createThinkingIndicator(bot, 42);
    await assert.doesNotReject(indicator.finish('Final'));
  });
});
