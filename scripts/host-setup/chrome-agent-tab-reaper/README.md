# Cierre de pestañas de agentes paradas (LUI-TSK-0138)

Extensión de Chrome para el portátil. Cada 5 minutos mira las pestañas de los
grupos cuyo título empieza por «Claude» (los que crea Claude in Chrome) y
cierra las que llevan 30 minutos sin que las mires ni el agente navegue en
ellas.

No toca nunca:

- las pestañas que no están en un grupo «Claude»;
- la pestaña activa de cada ventana;
- las pestañas que están sonando.

## Instalar

1. Abre `chrome://extensions` y activa el «Modo de desarrollador».
2. «Cargar extensión sin empaquetar» y elige esta carpeta.

## Ver qué ha cerrado

En `chrome://extensions`, en la extensión, abre «service worker» y en la
consola ejecuta `chrome.storage.local.get('closedTabs')`. Guarda los 100
últimos cierres con la hora, el id de la pestaña y el grupo.

## Cambiar el tiempo

`IDLE_LIMIT_MS` en `tab-reaper.js`. Después, «Recargar» la extensión.
