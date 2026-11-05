#!/bin/bash
# Сайт по домену с HTTPS прямо с этого Mac, при этом VPN на маке может оставаться включённым.
#
# До запуска:
#   1) у домена A-запись указывает на белый IP домашнего интернета;
#   2) на роутере порты 80 и 443 проброшены на этот Mac.
# Запуск:  bash ~/facade-tracker-v2/setup_domain.sh facade-pto.online
#
# Что делает:
#   • ставит Caddy — он сам получает и продлевает бесплатный сертификат Let's Encrypt;
#   • добавляет правило фильтра macOS (pf): ответы посетителям сайта уходят обратно через домашний
#     интернет, а не через VPN (иначе при включённом VPN сайт снаружи не открывается). Остальной
#     трафик мака по-прежнему идёт через VPN. Правило включается само после перезагрузки.
set -euo pipefail
cd "$(dirname "$0")"
DOMAIN="${1:-}"
PORT="${PORT:-8080}"
[ -n "$DOMAIN" ] || { echo "Укажите домен:  bash setup_domain.sh facade-pto.online"; exit 1; }
[[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "Странное имя домена: $DOMAIN"; exit 1; }
mkdir -p logs

# ── 1. сеть: через какой интерфейс и роутер мак подключён к домашнему интернету ──
IFACE=""
for i in en0 en1 en2 en3 en4 en5 en6; do
  if ipconfig getifaddr "$i" >/dev/null 2>&1; then IFACE="$i"; break; fi
done
[ -n "$IFACE" ] || { echo "Не нашёл подключение к домашней сети (en0/en1)."; exit 1; }
GW="$(ipconfig getoption "$IFACE" router || true)"
LANIP="$(ipconfig getifaddr "$IFACE")"
[ -n "$GW" ] || { echo "Не нашёл адрес роутера для $IFACE."; exit 1; }
echo "Домашняя сеть: $IFACE, адрес мака $LANIP, роутер $GW"

# ── 2. Caddy ──
if ! command -v caddy >/dev/null; then
  if command -v brew >/dev/null; then brew install caddy
  else echo "Нужен Homebrew: откройте https://brew.sh, выполните команду установки оттуда и запустите этот скрипт ещё раз."; exit 1; fi
fi
CADDYFILE="$(brew --prefix)/etc/Caddyfile"
cat > "$CADDYFILE" <<CF
{
	email admin@$DOMAIN
}
$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 2MB
	}
	reverse_proxy 127.0.0.1:$PORT
	header -Server
	log {
		output file $(pwd)/logs/caddy.log {
			roll_size 10MiB
			roll_keep 5
		}
	}
}
www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
CF
caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null
echo "Caddyfile: $CADDYFILE"

# ── 3. правило pf: ответы на входящие 80/443 — через домашний интернет, мимо VPN ──
echo "== Нужен пароль администратора Mac"
ANCHOR=/etc/pf.anchors/ru.fasady
sudo tee "$ANCHOR" >/dev/null <<PF
# Фасады: входящие соединения к сайту отвечаем через домашний роутер, даже если включён VPN
pass in quick on $IFACE reply-to ($IFACE $GW) inet proto tcp from any to $LANIP port { 80, 443 } keep state
PF
PFPLIST=/Library/LaunchDaemons/ru.fasady.pf.plist
sudo tee "$PFPLIST" >/dev/null <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ru.fasady.pf</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>
    <string>sleep 20; /sbin/pfctl -E; /sbin/pfctl -a com.apple/ru.fasady -f $ANCHOR</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PL
sudo launchctl bootout system "$PFPLIST" 2>/dev/null || true
sudo /sbin/pfctl -E 2>/dev/null || true
sudo /sbin/pfctl -a com.apple/ru.fasady -f "$ANCHOR"
sudo launchctl bootstrap system "$PFPLIST" 2>/dev/null || true
echo "Правило pf загружено:"; sudo /sbin/pfctl -a com.apple/ru.fasady -s rules

# ── 4. запуск Caddy службой (работает без входа в систему) ──
sudo brew services restart caddy
echo
echo "Жду сертификат (до минуты)…"
for i in $(seq 1 12); do
  sleep 5
  if curl -fsS -o /dev/null --max-time 8 "https://$DOMAIN/" 2>/dev/null; then echo "Готово: https://$DOMAIN открывается."; exit 0; fi
done
echo "Пока не открылось изнутри. Это бывает, если роутер не умеет открывать свой внешний адрес из домашней сети."
echo "Проверьте с телефона через мобильный интернет: https://$DOMAIN"
echo "Если не открывается и там — пришлите последние строки:  tail -30 $(pwd)/logs/caddy.log"
