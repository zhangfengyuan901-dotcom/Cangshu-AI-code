#!/bin/sh
set -eu

if [ "${1:-}" != "--confirm-disable" ]; then
  echo "Usage: $0 --confirm-disable" >&2
  exit 2
fi

cd "$(dirname "$0")"

docker compose -f compose.yaml -f compose.ecs.yaml exec -T postgres sh -lc '
  psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<"SQL"
UPDATE options
SET value = '\''false'\''
WHERE key = '\''TurnstileCheckEnabled'\'';
SQL
'

docker compose -f compose.yaml -f compose.ecs.yaml restart new-api >/dev/null

attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl -fsS http://127.0.0.1:3100/api/status | grep -q '"turnstile_check":false'; then
    echo '{"turnstile_check":false,"rollback_complete":true}'
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done

echo "Turnstile rollback did not become healthy in time" >&2
exit 1
