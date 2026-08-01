import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregate,
  summarise,
  startOfToday,
  startOfWeek,
  startOfMonth,
  startOfYear,
} from '../../../src/modules/dishwasher/dishwasher-history-store.js';

describe('dishwasher store — agregación', () => {
  // Miércoles 2026-07-15 12:00
  const now = new Date(2026, 6, 15, 12, 0).getTime();
  const cycles = [
    { date: new Date(2026, 6, 15, 8, 0).toISOString(), energy: 0.9, water: 12 }, // hoy
    { date: new Date(2026, 6, 13, 8, 0).toISOString(), energy: 1.0, water: 11 }, // lunes (esta semana)
    { date: new Date(2026, 6, 5, 8, 0).toISOString(), energy: 0.8, water: 10 },  // este mes, semana pasada
    { date: new Date(2026, 2, 3, 8, 0).toISOString(), energy: 1.2, water: 13 },  // este año, marzo
    { date: new Date(2025, 11, 31, 8, 0).toISOString(), energy: 5.0, water: 50 }, // año pasado
  ];

  it('startOf* dan los límites correctos', () => {
    assert.equal(new Date(startOfToday(now)).getDate(), 15);
    assert.equal(new Date(startOfWeek(now)).getDate(), 13); // lunes de esa semana
    assert.equal(new Date(startOfWeek(now)).getDay(), 1);
    assert.equal(new Date(startOfMonth(now)).getDate(), 1);
    assert.equal(new Date(startOfYear(now)).getMonth(), 0);
    assert.equal(new Date(startOfYear(now)).getDate(), 1);
  });

  it('aggregate cuenta y suma desde una fecha', () => {
    const a = aggregate(cycles, startOfToday(now));
    assert.equal(a.count, 1);
    assert.equal(a.energy, 0.9);
    assert.equal(a.water, 12);
  });

  it('summarise: hoy/semana/mes/año acumulan correctamente', () => {
    const s = summarise(cycles, now);
    assert.equal(s.today.count, 1);
    assert.equal(s.week.count, 2); // hoy + lunes
    assert.equal(s.month.count, 3); // + el del día 5
    assert.equal(s.year.count, 4); // + marzo (excluye el año pasado)
    assert.equal(s.year.count, 4);
    // sumas del año (0.9+1.0+0.8+1.2 = 3.9 kWh)
    assert.ok(Math.abs(s.year.energy - 3.9) < 1e-9);
    assert.equal(s.year.water, 12 + 11 + 10 + 13);
  });

  it('ignora energía/agua no numéricas sin romper el conteo', () => {
    const c = [{ date: new Date(2026, 6, 15, 9, 0).toISOString(), energy: null, water: undefined }];
    const a = aggregate(c, startOfToday(now));
    assert.equal(a.count, 1);
    assert.equal(a.energy, 0);
    assert.equal(a.water, 0);
  });
});
