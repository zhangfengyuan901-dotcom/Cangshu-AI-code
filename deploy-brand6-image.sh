#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_DIR=/opt/piknoai-relay/current
IMAGE_REF=pikno-new-api:v1.0.0-rc.41-brand.6
BUNDLE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
IMAGE_TAR=${1:-"$BUNDLE_DIR/pikno-new-api-brand6.tar"}
COMPOSE_SOURCE=${2:-"$BUNDLE_DIR/compose.yaml"}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="$TARGET_DIR/.deploy-backups/$STAMP"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run this script as root.' >&2
  exit 1
fi

for path in "$TARGET_DIR/.env" "$TARGET_DIR/compose.ecs.yaml" "$IMAGE_TAR" "$COMPOSE_SOURCE"; do
  if [[ ! -f "$path" ]]; then
    echo "Required file is missing: $path" >&2
    exit 1
  fi
done

mkdir -p "$BACKUP_DIR"
cp -a "$TARGET_DIR/compose.yaml" "$BACKUP_DIR/compose.yaml"

rollback() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo 'Deployment failed; restoring the previous compose definition.' >&2
    cp -a "$BACKUP_DIR/compose.yaml" "$TARGET_DIR/compose.yaml"
    cd "$TARGET_DIR"
    docker compose -f compose.yaml -f compose.ecs.yaml up -d --no-deps --wait new-api || true
  fi
  exit "$exit_code"
}
trap rollback EXIT

docker load --input "$IMAGE_TAR"
docker image inspect "$IMAGE_REF" >/dev/null
cp -a "$COMPOSE_SOURCE" "$TARGET_DIR/compose.yaml"

cd "$TARGET_DIR"
docker compose -f compose.yaml -f compose.ecs.yaml config --quiet
docker compose -f compose.yaml -f compose.ecs.yaml up -d --no-deps --wait new-api

container_id=$(docker compose -f compose.yaml -f compose.ecs.yaml ps -q new-api)
test -n "$container_id"
docker exec "$container_id" wget -q -O - http://127.0.0.1:3000/api/status | grep -q 'v1.0.0-rc.41-pikno.6'

trap - EXIT
echo "PIKNO brand.6 deployed successfully; backup: $BACKUP_DIR"
