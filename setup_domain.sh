#!/bin/bash
# Выход в интернет по домену с HTTPS: Caddy сам получает и продлевает сертификат Let's Encrypt.
# До запуска: домен куплен, его A-запись указывает на ваш белый IP, на роутере проброшены порты 80 и 443 на этот Mac.
# Запуск:  ./setup_domain.sh fasad-v14.ru
set -euo pipefail
cd "$(dirname "$0")"
DOMAIN="${1:-}"
PORT="${PORT:-8080}"
[ -n "$DOMAIN" ] || { echo "Укажите домен:  ./setup_domain.sh fasad-v14.ru"; exit 1; }

if ! command -v brew >/dev/null; then
  echo "Нужен Homebrew: https://brew.sh — установите и запустите скрипт ещё раз."; exit 1
fi
command -v caddy >/dev/null || brew install caddy

PUB="$(curl -fsS https://ifconfig.me 2>/dev/null || true)"
DNS="$(dig +short "$DOMAIN" A | tail -1 || true)"
echo "Внешний IP этого подключения: ${PUB:-?};  A-запись $DOMAIN: ${DNS:-нет}"
if [ -n "$PUB" ] && [ "$PUB" != "$DNS" ]; then
  echo "ВНИМАНИЕ: домен пока не указывает на этот IP. Поправьте A-запись у регистратора (обновление до пары часов)."
  read -r -p "Продолжить всё равно? [y/N] " A; [ "${A:-N}" = "y" ] || exit 1
fi

CADDYFILE="$(brew --prefix)/etc/Caddyfile"
cat > "$CADDYFILE" <<CF
$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 2MB
	}
	reverse_proxy 127.0.0.1:$PORT
	header -Server
	log {
		output file $(pwd)/logs/caddy.log
	}
}
CF
echo "Caddyfile: $CADDYFILE"
caddy validate --config "$CADDYFILE" --adapter caddyfile
# служба от root — работает без входа в систему
sudo brew services restart caddy
sleep 5
echo
echo "Проверка: https://$DOMAIN"
curl -fsS -o /dev/null -w "HTTP %{http_code}\n" "https://$DOMAIN/" \
  || echo "Пока не открывается. Проверьте проброс портов 80/443 на роутере и A-запись; логи: logs/caddy.log"
