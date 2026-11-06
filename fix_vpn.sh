#!/bin/bash
# Сайт снаружи при включённой защите от утечек AmneziaVPN: переустанавливает правила pf и Caddy.
# Запуск:  bash ~/facade-tracker-v2/fix_vpn.sh
exec bash "$(dirname "$0")/setup_domain.sh" facade-pto.online
