import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDailyReportTool } from '../../../../src/modules/agent/tools/daily-report-tool.js';

describe('get_daily_report tool', () => {
  const entries = [
    { ts: '2026-11-08T07:30:00Z', level: 'info', urgent: false, text: '🩺 <b>Parte diario</b>: todo &amp; bien' },
    { ts: '2026-11-08T15:00:00Z', level: 'warn', urgent: true, text: '🌧️ Lluvia probable hacia las 16:00' },
  ];
  const notificationLog = { today: () => entries };

  it('lists today\'s notices as plain text with their local time', async () => {
    const tool = createDailyReportTool({ notificationLog, timeZone: 'UTC' });

    const result = await tool.execute({});

    assert.equal(tool.name, 'get_daily_report');
    assert.deepEqual(result, {
      total: 2,
      avisos: [
        { hora: '07:30', urgente: false, texto: '🩺 Parte diario: todo & bien' },
        { hora: '15:00', urgente: true, texto: '🌧️ Lluvia probable hacia las 16:00' },
      ],
    });
  });

  it('keeps only the latest notices and says so', async () => {
    const result = await createDailyReportTool({ notificationLog, timeZone: 'UTC', maxEntries: 1 }).execute({});

    assert.equal(result.total, 2);
    assert.deepEqual(result.avisos.map((a) => a.hora), ['15:00']);
    assert.match(result.aviso, /1 últimos/);
  });

  it('adds the heating summary when Home Assistant is available', async () => {
    const fetchHaStates = async () => [];
    const tool = createDailyReportTool({ notificationLog, timeZone: 'UTC', fetchHaStates });

    const result = await tool.execute({});

    assert.match(result.calefaccion, /Sin datos/);
    assert.doesNotMatch(result.calefaccion, /<b>/);
  });
});
