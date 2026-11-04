#!/bin/bash
# Установка фасад-трекера на Mac mini как службы (запускается сама при включении, без входа в систему).
# Запуск:  cd ~/facade-tracker && ./install.sh
set -euo pipefail
cd "$(dirname "$0")"
APP_DIR="$(pwd)"
LABEL="ru.v14.facade-tracker"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
PORT="${PORT:-8080}"

echo "== Фасад-трекер В14: установка в $APP_DIR"

PY="$(command -v python3 || true)"
if [ -z "$PY" ] || ! "$PY" -c 'import sqlite3, sys; assert sys.version_info >= (3, 9)' 2>/dev/null; then
  echo "Нужен Python 3.9+. Установите Command Line Tools:  xcode-select --install   и запустите install.sh ещё раз."
  exit 1
fi
PY="$("$PY" -c 'import sys; print(sys.executable)')"
echo "Python: $PY"

ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo
  echo "Пароль на редактирование: без него закрашивать сможет любой, у кого есть ссылка."
  read -r -s -p "Придумайте пароль (Enter — без пароля): " TOKEN; echo
  printf 'EDIT_TOKEN=%s\n' "$TOKEN" > "$ENV_FILE"; chmod 600 "$ENV_FILE"
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
mkdir -p "$APP_DIR/data" "$APP_DIR/logs"

echo "== Служба (нужен пароль администратора Mac)"
sudo tee "$PLIST" >/dev/null <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$APP_DIR/server.py</string></array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>UserName</key><string>$(whoami)</string>
  <key>EnvironmentVariables</key><dict>
    <key>PORT</key><string>$PORT</string>
    <key>HOST</key><string>0.0.0.0</string>
    <key>EDIT_TOKEN</key><string>${EDIT_TOKEN:-}</string>
    <key>DATA_DIR</key><string>$APP_DIR/data</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP_DIR/logs/server.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/logs/server.log</string>
</dict></plist>
PL
sudo chmod 600 "$PLIST"
sudo launchctl bootout system "$PLIST" 2>/dev/null || true
sudo launchctl bootstrap system "$PLIST"

echo "== Mac mini не будет засыпать и сам включится после отключения света"
sudo pmset -a sleep 0 disksleep 0 autorestart 1 >/dev/null || true

sleep 2
if curl -fsS "http://127.0.0.1:$PORT/api/config" >/dev/null; then
  echo "Сервер работает."
else
  echo "Сервер не ответил — смотрите $APP_DIR/logs/server.log"; exit 1
fi

if [ -z "${SKIP_IMPORT:-}" ]; then
echo
read -r -p "Перенести уже накрашенное из Google Таблицы сейчас? [Y/n] " ANS
if [ "${ANS:-Y}" != "n" ] && [ "${ANS:-Y}" != "N" ]; then
  DATA_DIR="$APP_DIR/data" "$PY" "$APP_DIR/import_google.py" || echo "Импорт не удался — можно повторить позже: python3 import_google.py"
fi
fi

IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 'IP-адрес-мака')"
echo
echo "Готово. В домашней сети сайт открывается по адресу:  http://$IP:$PORT"
echo "Чтобы открыть его из интернета по домену — ./setup_domain.sh ваш-домен.ru (см. README.md)."
