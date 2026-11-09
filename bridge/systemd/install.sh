#!/usr/bin/env bash
# Instala a ponte como serviço systemd (rodar como root, com o sim do dono).
# Reversão: systemctl disable --now dpo2u-lgpd-bridge && rm /etc/systemd/system/dpo2u-lgpd-bridge.service /etc/dpo2u-lgpd-bridge.env && systemctl daemon-reload
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[ -f /root/.config/dpo2u/lgpd-bridge.token ] || { umask 077; openssl rand -hex 32 > /root/.config/dpo2u/lgpd-bridge.token; }
chmod 600 /root/.config/dpo2u/lgpd-bridge.token
[ -f /etc/dpo2u-lgpd-bridge.env ] || install -m 600 "$here/dpo2u-lgpd-bridge.env.example" /etc/dpo2u-lgpd-bridge.env
install -m 644 "$here/dpo2u-lgpd-bridge.service" /etc/systemd/system/dpo2u-lgpd-bridge.service
systemctl daemon-reload
systemctl enable --now dpo2u-lgpd-bridge
sleep 2
systemctl is-active dpo2u-lgpd-bridge
ss -ltnp | grep ':8788 '
