# temperature — watcher de temperatura (LUI-TSK-0071)

Vigila los sensores de temperatura de Home Assistant y avisa por Telegram según
la temporada. El aviso lo emite el `notificationService` (canal Telegram), como
el cluster watcher.

## Lógica estacional

| Temporada | Meses (por defecto) | Alerta cuando |
|-----------|---------------------|---------------|
| Verano (calor) | may–oct | media de la casa ≥ 30.0 **o** alguna habitación ≥ 31.0 |
| Invierno (frío) | nov–abr | media de la casa ≤ 20.1 **o** alguna habitación ≤ 20.1 |

- **Media de la casa**: promedio de todos los sensores `device_class=temperature`
  válidos, excluidos los no interiores (ver `TEMP_EXCLUDE_PATTERN`).
- **Por habitación**: se agrupa por `area_name`; la temperatura de la habitación
  es la media de sus sensores.
- **Anti-spam**: un único aviso al entrar en alerta; re-aviso sólo cada
  `TEMP_REALERT_MS` mientras persista; aviso de normalización al volver al rango.
- **Franja silenciosa**: dentro de la ventana nocturna detecta pero no avisa; al
  salir, si la alerta sigue, avisa.
- Lecturas `unknown`/`unavailable` o HA caído → se descartan, nunca se inventan.

Mensajes en español, formato:

```
🌡️ Hace calor en casa
Temperatura Cocina: 31.3º | Temperatura media: 29.7º
```

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `TEMP_WATCHER_ENABLED` | `false` | Activa el watcher (requiere `HA_BASE_URL` + `HA_TOKEN`) |
| `TEMP_CHECK_INTERVAL_MS` | `900000` (15 min) | Cada cuánto comprueba |
| `TEMP_SUMMER_MONTHS` | `5,6,7,8,9,10` | Meses de verano (1-12) |
| `TEMP_WINTER_MONTHS` | `11,12,1,2,3,4` | Meses de invierno (1-12) |
| `TEMP_SUMMER_MEAN_MAX` | `30.0` | Umbral de media en verano |
| `TEMP_SUMMER_ROOM_MAX` | `31.0` | Umbral por habitación en verano |
| `TEMP_WINTER_MEAN_MIN` | `20.1` | Umbral de media en invierno |
| `TEMP_WINTER_ROOM_MIN` | `20.1` | Umbral por habitación en invierno |
| `TEMP_REALERT_MS` | `10800000` (3 h) | Re-aviso mientras persista la alerta |
| `TEMP_EXCLUDE_PATTERN` | `exterior\|nevera\|…` | Regex (i) de sensores a excluir de la media/vigilancia |
| `TEMP_QUIET_START` | `23:00` | Inicio de la franja silenciosa (HH:MM) |
| `TEMP_QUIET_END` | `08:00` | Fin de la franja silenciosa (HH:MM) |
