#!/bin/sh
set -eu
cd /opt/piknoai-relay/current
compose() { docker compose -f compose.yaml -f compose.ecs.yaml -f compose.payments.yaml -f compose.tunnel.yaml "$@"; }
expected_old='pikno-new-api:v1.0.0-rc.41-brand.9'
new_image='pikno-new-api:v1.0.0-rc.41-brand.10'
actual_old=$(docker inspect --format '{{.Config.Image}}' piknoai-relay-new-api-1)
test "$actual_old" = "$expected_old"
grep -q "image: $expected_old" compose.yaml
test -n "${1:-}"
printf '%s  %s\n' "$1" /opt/piknoai-relay/pikno-client10-image.tar | sha256sum -c -
docker load --input /opt/piknoai-relay/pikno-client10-image.tar
test "$(docker exec piknoai-relay-postgres-1 psql -U pikno -d newapi -At -c "SELECT count(*) FROM tasks WHERE status NOT IN ('SUCCESS','FAILURE');")" = 0
backup='.deploy-backups/client10-20261008'
test ! -e "$backup"
umask 077
mkdir -p "$backup"
cp compose.yaml compose.ecs.yaml compose.payments.yaml compose.tunnel.yaml .env "$backup/"
docker exec piknoai-relay-postgres-1 pg_dump -U pikno -d newapi -Fc > "$backup/newapi.dump"
test -s "$backup/newapi.dump"
docker exec piknoai-relay-postgres-1 psql -U pikno -d newapi -At -c 'SELECT id,status FROM channels ORDER BY id;' > "$backup/channels-before.txt"
docker exec piknoai-relay-postgres-1 psql -U pikno -d newapi -At -c 'SELECT md5(string_agg(row_to_json(o)::text,chr(10) ORDER BY key)) FROM options o;' > "$backup/options-before.hash"
sed -i 's@image: pikno-new-api:v1.0.0-rc.41-brand.9@image: pikno-new-api:v1.0.0-rc.41-brand.10@' compose.yaml
if ! compose up -d --no-deps --no-build --wait --wait-timeout 150 new-api; then
  cp "$backup/compose.yaml" compose.yaml
  compose up -d --no-deps --no-build --wait new-api
  echo 'CLIENT10_FAILED_ROLLED_BACK'
  exit 1
fi
docker exec piknoai-relay-postgres-1 psql -U pikno -d newapi -At -c 'SELECT id,status FROM channels ORDER BY id;' > "$backup/channels-after.txt"
docker exec piknoai-relay-postgres-1 psql -U pikno -d newapi -At -c 'SELECT md5(string_agg(row_to_json(o)::text,chr(10) ORDER BY key)) FROM options o;' > "$backup/options-after.hash"
cmp "$backup/channels-before.txt" "$backup/channels-after.txt"
cmp "$backup/options-before.hash" "$backup/options-after.hash"
echo 'CLIENT10_HEALTHY_CONFIG_UNCHANGED'
compose ps --format '{{.Name}} {{.Image}} {{.Status}}'
