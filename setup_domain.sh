#!/bin/bash
# Сайт по домену с HTTPS прямо с этого Mac, при этом VPN на маке может оставаться включённым.
#
# До запуска:
#   1) у домена A-запись указывает на белый IP домашнего интернета;
#   2) на роутере порты 80 и 443 проброшены на этот Mac.
# Запуск:  bash ~/facade-tracker-v2/setup_domain.sh facade-pto.online
#
# Что делает:
#   • скачивает Caddy (официальная сборка, проверка SHA-512) — он сам получает и продлевает сертификат Let's Encrypt;
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

# ── 2. Caddy — скачиваем официальную сборку с GitHub и сверяем контрольную сумму (Homebrew не нужен) ──
CADDY_VER=2.11.9
case "$(uname -m)" in
  x86_64) ARCH=amd64; SUM=c36155058098d916a2f3049be3ade6ccb0a1cb0cf3cb50ee8806ea67d5249e567cf053024a5a4d2d50df5ec338c84c52aae1dfb147dfc62cabe1574a36d39282 ;;
  arm64)  ARCH=arm64; SUM=166a8fdd183dc597ebe3a12d71e2e8eb313ab673ae8d3e286cb92bb0078d04233c23347543f7d7e8285b44136416e6718b0d106afe973de8ede4d81b6809c6bb ;;
  *) echo "Неизвестная архитектура $(uname -m)"; exit 1 ;;
esac
APP="$(pwd)"; BIN="$APP/data/bin"; CADDY="$BIN/caddy"; CDATA="$APP/data/caddy"
mkdir -p "$BIN" "$CDATA"
if [ ! -x "$CADDY" ] || ! "$CADDY" version 2>/dev/null | grep -q "v$CADDY_VER"; then
  TGZ="$BIN/caddy.tar.gz"
  echo "Скачиваю Caddy $CADDY_VER ($ARCH)…"
  curl -fL --retry 3 -o "$TGZ" "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VER/caddy_${CADDY_VER}_mac_${ARCH}.tar.gz"
  echo "$SUM  $TGZ" | shasum -a 512 -c - >/dev/null || { echo "Контрольная сумма не совпала — файл повреждён или подменён, останавливаюсь."; rm -f "$TGZ"; exit 1; }
  tar -xzf "$TGZ" -C "$BIN" caddy && rm -f "$TGZ" && chmod 755 "$CADDY"
fi
"$CADDY" version
CADDYFILE="$CDATA/Caddyfile"
cat > "$CADDYFILE" <<CF
{
	email admin@$DOMAIN
	admin off
}
$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 2MB
	}
	reverse_proxy 127.0.0.1:$PORT
	header -Server
	log {
		output file $APP/logs/caddy.log {
			roll_size 10MiB
			roll_keep 5
		}
	}
}
www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
CF
"$CADDY" validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 || "$CADDY" validate --config "$CADDYFILE" --adapter caddyfile
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

# ── 4. Caddy службой: стартует сам при включении мака, без входа в систему ──
CPLIST=/Library/LaunchDaemons/ru.fasady.caddy.plist
sudo tee "$CPLIST" >/dev/null <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ru.fasady.caddy</string>
  <key>ProgramArguments</key><array><string>$CADDY</string><string>run</string><string>--config</string><string>$CADDYFILE</string><string>--adapter</string><string>caddyfile</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>XDG_DATA_HOME</key><string>$CDATA</string>
    <key>XDG_CONFIG_HOME</key><string>$CDATA</string>
    <key>HOME</key><string>$CDATA</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP/logs/caddy-service.log</string>
  <key>StandardErrorPath</key><string>$APP/logs/caddy-service.log</string>
</dict></plist>
PL
sudo chmod 644 "$CPLIST"
sudo launchctl bootout system "$CPLIST" 2>/dev/null || true
sudo launchctl bootstrap system "$CPLIST"
echo
echo "Жду сертификат (до минуты)…"
for i in $(seq 1 12); do
  sleep 5
  if curl -fsS -o /dev/null --max-time 8 "https://$DOMAIN/" 2>/dev/null; then echo "Готово: https://$DOMAIN открывается."; exit 0; fi
done
echo "Пока не открылось изнутри. Это бывает, если роутер не умеет открывать свой внешний адрес из домашней сети."
echo "Проверьте с телефона через мобильный интернет: https://$DOMAIN"
echo "Если не открывается и там — пришлите последние строки:  tail -30 $(pwd)/logs/caddy-service.log"
