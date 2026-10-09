#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
TARGET=/opt/piknoai-relay/current
BUNDLE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
BACKUP="$TARGET/.deploy-backups/wallet7-$(date -u +%Y%m%dT%H%M%SZ)"
cd "$TARGET"
mkdir -p "$BACKUP"
cp -a compose.yaml compose.ecs.yaml compose.payments.yaml "$BACKUP/"
cp -a ../lanjing-bridge/server.mjs "$BACKUP/bridge-server.mjs"
docker compose -f compose.yaml -f compose.ecs.yaml exec -T postgres pg_dump -U pikno -d newapi -Fc > "$BACKUP/database.dump"
test -s "$BACKUP/database.dump"
docker load -i "$BUNDLE/pikno-wallet7-images.tar"
docker image inspect pikno-new-api:v1.0.0-rc.41-brand.7 >/dev/null
docker image inspect pikno-lanjing-bridge:fixed-cny-1 >/dev/null

# Check the exact known prior app image instead of overwriting unrelated config.
grep -q 'image: pikno-new-api:v1.0.0-rc.41-brand.6' compose.yaml
sed 's@image: pikno-new-api:v1.0.0-rc.41-brand.6@image: pikno-new-api:v1.0.0-rc.41-brand.7@; /NODE_NAME:/a\      PIKNO_FIXED_CNY_TOPUP: "true"' compose.yaml > "$BACKUP/compose.next.yaml"
grep -q PIKNO_FIXED_CNY_TOPUP "$BACKUP/compose.next.yaml"
sed '/^  lanjing-bridge:/a\    image: pikno-lanjing-bridge:fixed-cny-1' compose.payments.yaml > "$BACKUP/payments.next.yaml"
cp "$BACKUP/compose.next.yaml" compose.yaml
cp "$BACKUP/payments.next.yaml" compose.payments.yaml
cp "$BUNDLE/bridge-server.mjs" ../lanjing-bridge/server.mjs
docker compose -f compose.yaml -f compose.ecs.yaml -f compose.payments.yaml config --quiet
docker compose -f compose.yaml -f compose.ecs.yaml -f compose.payments.yaml up -d --no-deps --no-build --wait new-api lanjing-bridge
curl -fsS http://127.0.0.1:3100/api/status | grep -q 'v1.0.0-rc.41-pikno.7'
docker compose -f compose.yaml -f compose.ecs.yaml -f compose.payments.yaml ps
printf 'Wallet7 deployed; backup: %s\n' "$BACKUP"
# Do not automatically roll back to brand.6 after accepting fixed-CNY orders:
# that old binary cannot interpret the new quota snapshots. Roll forward or
# close checkout and reconcile pending snapshot orders before any rollback.
