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
  válidos, excluidos los no interiores (ver `TEMP_EXCLUDE_PATTERN`) y, por
  defecto, los que no tienen habitación asignada (ver `TEMP_REQUIRE_AREA`) —
  esto descarta duplicados y dispositivos con valores basura (p.ej. 0.0).
- **Por habitación**: se agrupa por `area_name`; la temperatura de la habitación
  es la media de sus sensores.
- **Anti-spam**: un único aviso al entrar en alerta; re-aviso sólo cada
  `TEMP_REALERT_MS` mientras persista.
- **Histéresis**: tras una alerta, la vuelta al rango NO se declara al cruzar de
  vuelta el umbral de alerta, sino al alcanzar el umbral de recuperación
  (`TEMP_SUMMER_RECOVERY_MEAN`=25 en verano, `TEMP_WINTER_RECOVERY_MEAN`=22 en
  invierno). El aviso de bajada es útil (p.ej. apagar el aire) y no dice
  "normalizada".
- **Franja silenciosa**: dentro de la ventana nocturna detecta pero no avisa; al
  salir, si la alerta sigue, avisa.
- **Anuncio por voz (Alexa)**: opcional (`TEMP_ALEXA_ENABLED`). Los avisos de
  temperatura (subida y bajada) se anuncian también por los Echo vía HA. NUNCA
  suena entre `TEMP_ALEXA_QUIET_START` y `TEMP_ALEXA_QUIET_END` (22:00–09:00 por
  defecto), aunque Telegram sí notifique en esa franja.
- **Temperatura exterior**: si `TEMP_OUTDOOR_ENTITY` apunta a un sensor con
  lectura válida, se añade al aviso. Ese sensor se **excluye** del cómputo
  interior (media y habitaciones), aunque tenga un área interior asignada. Si
  está `unavailable`, se omite del mensaje (no se inventa).
- **Humedad relativa media interior**: se añade a los avisos, calculada sobre los
  sensores `device_class=humidity` con el mismo filtro (área + exclusiones).
- Lecturas `unknown`/`unavailable` o HA caído → se descartan, nunca se inventan.

Se añade a los avisos de calor, frío y de bajada. Mensajes en español:

```
🌡️ Hace calor en casa
Temperatura Cocina: 31.3º | Temperatura media: 29.7º
🌡️ Exterior: 34.2º · 💧 Humedad media: 45%
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
| `TEMP_SUMMER_RECOVERY_MEAN` | `25.0` | Histéresis verano: media a la que se avisa la bajada |
| `TEMP_WINTER_RECOVERY_MEAN` | `22.0` | Histéresis invierno: media a la que se avisa la subida |
| `TEMP_REALERT_MS` | `10800000` (3 h) | Re-aviso mientras persista la alerta |
| `TEMP_ALEXA_ENABLED` | `false` | Anunciar también por voz en Alexa (vía HA) |
| `TEMP_ALEXA_TARGET` | (vacío) | Echo destino (alias); vacío = toda la casa |
| `TEMP_ALEXA_QUIET_START` | `22:00` | Inicio de la franja sin voz (Telegram sí) |
| `TEMP_ALEXA_QUIET_END` | `09:00` | Fin de la franja sin voz |
| `TEMP_EXCLUDE_PATTERN` | `exterior\|nevera\|…` | Regex (i) de sensores a excluir de la media/vigilancia |
| `TEMP_REQUIRE_AREA` | `true` | Solo cuenta sensores con habitación asignada (descarta ruido sin área) |
| `TEMP_OUTDOOR_ENTITY` | (vacío) | entity_id del sensor de temperatura exterior; se añade al aviso y se excluye del interior |
| `TEMP_QUIET_START` | `23:00` | Inicio de la franja silenciosa (HH:MM) |
| `TEMP_QUIET_END` | `08:00` | Fin de la franja silenciosa (HH:MM) |
