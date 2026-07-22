import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHouseAverageFilter } from '../../../src/modules/home-assistant/sensor-filter.js';

/**
 * @param {string} entity_id
 * @param {string} [friendly_name]
 * @param {string} [area_name]
 */
function sensor(entity_id, friendly_name = '', area_name = 'Salón') {
  return { entity_id, friendly_name: friendly_name || entity_id, area_name };
}

describe('createHouseAverageFilter', () => {
  it('sin configuración incluye todos los sensores', () => {
    const keep = createHouseAverageFilter({});
    assert.equal(keep(sensor('sensor.a')), true);
    assert.equal(keep(sensor('sensor.b', 'Lo que sea', '')), true);
  });

  it('excluye por patrón mirando entity_id, friendly_name y área', () => {
    const keep = createHouseAverageFilter({ excludePattern: 'cocina' });
    assert.equal(keep(sensor('sensor.cocina_temp', 'X', 'Salón')), false, 'por entity_id');
    assert.equal(keep(sensor('sensor.x', 'Sensor COCINA Temperature', 'Salón')), false, 'por friendly_name');
    assert.equal(keep(sensor('sensor.y', 'Sensor', 'Cocina')), false, 'por área');
    assert.equal(keep(sensor('sensor.z', 'Sensor', 'Salón')), true);
  });

  it('excluye el sensor exterior configurado (outdoorEntity)', () => {
    const keep = createHouseAverageFilter({ outdoorEntity: 'sensor.ext5' });
    assert.equal(keep(sensor('sensor.ext5')), false);
    assert.equal(keep(sensor('sensor.otro')), true);
  });

  it('con requireArea descarta sensores sin área (valores basura)', () => {
    const keep = createHouseAverageFilter({ requireArea: true });
    assert.equal(keep(sensor('sensor.huerfano', 'X', '')), false);
    assert.equal(keep(sensor('sensor.huerfano2', 'X', '   ')), false);
    assert.equal(keep(sensor('sensor.ok', 'X', 'Salón')), true);
  });

  it('un patrón inválido no rompe ni excluye nada', () => {
    const keep = createHouseAverageFilter({ excludePattern: '((((' });
    assert.equal(keep(sensor('sensor.a')), true);
  });

  it('caso real: excluye cocina, terraza cocina y Ext 5; mantiene despacho, salón y dormitorios', () => {
    // Patrón que se configurará en producción (TEMP_EXCLUDE_PATTERN).
    const keep = createHouseAverageFilter({
      excludePattern: 'cocina|ext[ _]?5',
      outdoorEntity: 'sensor.sensor_temp_and_humedad_ext_5_temperature',
      requireArea: true,
    });

    // Fuera: los dos de la cocina (no tiene salida de aire y siempre está más caliente).
    assert.equal(keep(sensor('sensor.sensor_temp_y_humedad_cocina_temperature', 'Sensor Temp y Humedad COCINA Temperature', 'Cocina')), false);
    assert.equal(keep(sensor('sensor.sensor_temp_y_humedad_cocina_humidity', 'Sensor Temp y Humedad COCINA Humidity', 'Cocina')), false);
    // Fuera: terraza de la cocina (exterior, colgado del área Cocina).
    assert.equal(keep(sensor('sensor.sensor_temp_and_humedad_terraza_cocina_6_temperature', 'Sensor Temp&Humedad Terraza Cocina 6 Temperature', 'Cocina')), false);
    // Fuera: Ext 5, tanto temperatura como humedad (exterior colgado del Despacho).
    assert.equal(keep(sensor('sensor.sensor_temp_and_humedad_ext_5_temperature', 'Sensor Temp&Humedad Ext 5 Temperature', 'Despacho')), false);
    assert.equal(keep(sensor('sensor.sensor_temp_and_humedad_ext_5_humidity', 'Sensor Temp&Humedad Ext 5 Humidity', 'Despacho')), false);

    // Dentro: despacho interno, salón y dormitorios.
    assert.equal(keep(sensor('sensor.sensor_temp_y_humedad_despacho_temperature', 'Sensor Temp y Humedad DESPACHO Temperature', 'Despacho')), true);
    assert.equal(keep(sensor('sensor.netatmo_valve_2_current_temperature_2', 'Netatmo Valve 2 Current Temperature', 'Despacho')), true);
    assert.equal(keep(sensor('sensor.netatmo_smart_thermostat_current_temperature', 'Netatmo Smart Thermostat Current Temperature', 'Salón')), true);
    assert.equal(keep(sensor('sensor.netatmo_valve_3_current_temperature', 'Netatmo Valve 3 Current Temperature', 'Dormitorio')), true);
    assert.equal(keep(sensor('sensor.sensor_temp_and_humedad_cuartodani_temperature', 'Sensor Temp&Humedad CUARTODANI Temperature', 'Cuarto Dani')), true);
    assert.equal(keep(sensor('sensor.sensor_temp_and_humedad_dormitorio_ppal_8_temperature', 'Sensor Temp&Humedad Dormitorio Ppal 8 Temperature', 'Dormitorio Principal')), true);
  });
});
