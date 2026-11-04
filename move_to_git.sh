#!/bin/bash
# Разовый переезд службы в папку, скачанную через GitHub Desktop.
# После этого обновления — кнопкой «Pull origin» в GitHub Desktop, без Терминала.
# Запуск:  bash ~/facade-tracker-v2/move_to_git.sh
set -euo pipefail
cd "$(dirname "$0")"
NEW="$(pwd)"
OLD="${1:-$HOME/facade-tracker}"
LABEL="ru.v14.facade-tracker"

case "$NEW" in
  "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*)
    echo "Папка $NEW находится в Документах/Рабочем столе/Загрузках — macOS не даст службе её читать."
    echo "В GitHub Desktop удалите репозиторий из списка и склонируйте заново, указав Local path: $HOME"
    exit 1;;
esac
if [ "$OLD" = "$NEW" ] || [ ! -d "$OLD" ]; then echo "Не найдена старая папка $OLD"; exit 1; fi

echo "== Останавливаю службу (нужен пароль администратора Mac)"
sudo launchctl bootout system "/Library/LaunchDaemons/$LABEL.plist" 2>/dev/null || true
sleep 1

mkdir -p data logs
if [ -f "$OLD/data/tracker.db" ] && [ ! -f data/tracker.db ]; then
  echo "== Копирую базу закраски из $OLD/data"
  cp -pR "$OLD/data/." data/
fi
if [ ! -f .env ] && [ -f "$OLD/.env" ]; then cp -p "$OLD/.env" .env; fi

SKIP_IMPORT=1 bash ./install.sh

echo
echo "Служба теперь работает из $NEW."
echo "Старую папку $OLD можно оставить как резервную копию или удалить вручную."
