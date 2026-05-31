# apt-health → LUIS → Telegram

Aviso por Telegram cuando un host del cluster tiene problemas de actualización
automática (fallo de unattended-upgrade, paquetes pendientes acumulados, reboot
pendiente). Diseñado para correr en n2, n3, n4 y servidorix por igual.

## Qué hace

Un script (`apt-health-check.sh`) ejecuta 3 chequeos cada día a las 07:30 y
otra ejecución reactiva cuando `apt-daily-upgrade.service` falla:

| Evento | Cuándo dispara |
|---|---|
| `upgrade-failed` | El log de unattended-upgrades tiene `ERROR` desde ayer, **o** `apt-daily-upgrade.service` salió con código distinto de cero. |
| `pending-old` | ≥ `MIN_PENDING` paquetes pendientes desde hace > `PENDING_DAYS` días (default 5 y 5). |
| `reboot-pending` | `/var/run/reboot-required` existe desde hace > `REBOOT_DAYS` días (default 7). |

Cada evento se manda como `POST` a LUIS, que lo reenvía a Telegram. Dedup en
LUIS evita repetir el mismo `(host, event, día)` dentro de 24 h.

## Requisitos

- LUIS desplegado con `APT_HEALTH_WEBHOOK_TOKEN` definido en su `.env`.
- Cada host debe poder hacer `curl` a la URL del webhook de LUIS.
- `bash`, `apt`, `curl`, `systemd` (todos presentes en Ubuntu por defecto).

## Instalación en un host (n2, n3, n4 o servidorix)

Todo requiere `sudo`.

```bash
# 1. Crear fichero de config con la URL y el token.
sudo tee /etc/apt-health-check.env >/dev/null <<EOF
APT_HEALTH_WEBHOOK_URL=http://servidorix:3030/api/hooks/apt-health
APT_HEALTH_WEBHOOK_TOKEN=<el-token-que-pusiste-en-el-.env-de-luis>
# Opcional: override del nombre del host reportado (default: hostname)
# APT_HEALTH_HOST=n4
# Opcional: thresholds (defaults entre paréntesis)
# MIN_PENDING=5
# PENDING_DAYS=5
# REBOOT_DAYS=7
EOF
sudo chmod 600 /etc/apt-health-check.env  # contiene secreto

# 2. Copiar script y darle permisos de ejecución.
sudo install -m 0755 apt-health-check.sh /usr/local/bin/apt-health-check.sh

# 3. Instalar unidades systemd.
sudo install -m 0644 apt-health-check.service /etc/systemd/system/
sudo install -m 0644 apt-health-check.timer   /etc/systemd/system/
sudo install -m 0644 apt-health-alert.service /etc/systemd/system/

# 4. Drop-in que engancha el alerta inmediato cuando falla apt-daily-upgrade.
sudo mkdir -p /etc/systemd/system/apt-daily-upgrade.service.d
sudo install -m 0644 onfailure-apt-health.conf \
  /etc/systemd/system/apt-daily-upgrade.service.d/onfailure-apt-health.conf

# 5. Activar el timer.
sudo systemctl daemon-reload
sudo systemctl enable --now apt-health-check.timer
```

## Verificar

```bash
# Timer registrado y próximo disparo
systemctl list-timers apt-health-check.timer

# Forzar una ejecución ahora (envía 0-3 eventos según estado real)
sudo systemctl start apt-health-check.service
journalctl -u apt-health-check.service -n 30

# Simular el evento de fallo (el que dispara el drop-in OnFailure)
sudo systemctl start apt-health-alert.service
journalctl -u apt-health-alert.service -n 20
```

Si todo está bien deberías ver en el journal una línea como:
```
apt-health-check: event=upgrade-failed http=200
```
y un mensaje en Telegram en el chat de notificaciones de LUIS.

## Estado local

El script guarda en `/var/lib/apt-health-check/pending-first-seen` cuándo vio
por primera vez cada paquete pendiente. Eso permite distinguir "lleva 1 día
pendiente" de "lleva 5 días pendiente". Si lo borras, el contador empieza
de cero (no es problemático, solo retrasa el primer `pending-old`).

## Quitar el aviso

```bash
sudo systemctl disable --now apt-health-check.timer
sudo rm /etc/systemd/system/apt-health-check.{service,timer}
sudo rm /etc/systemd/system/apt-health-alert.service
sudo rm /etc/systemd/system/apt-daily-upgrade.service.d/onfailure-apt-health.conf
sudo rmdir /etc/systemd/system/apt-daily-upgrade.service.d 2>/dev/null || true
sudo rm /usr/local/bin/apt-health-check.sh
sudo rm /etc/apt-health-check.env
sudo rm -rf /var/lib/apt-health-check
sudo systemctl daemon-reload
```
