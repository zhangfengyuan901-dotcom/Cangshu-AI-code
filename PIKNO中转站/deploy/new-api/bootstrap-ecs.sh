#!/bin/bash
# Run as root via the authenticated ECS Cloud Assistant. Contains no secrets.
set -euo pipefail
test "$(id -u)" = 0
. /etc/os-release
test "$ID" = ubuntu
test "${VERSION_CODENAME}" = resolute
if command -v docker >/dev/null 2>&1; then
  docker version
  docker compose version
  exit 0
fi
for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
    echo "STOP: inspect existing package $package before installing Docker CE"
    exit 1
  fi
done
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y --no-install-recommends ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
test ! -e /etc/apt/sources.list.d/docker.sources
curl --connect-timeout 15 --max-time 60 -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update -q
apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
install -d -m 0700 /opt/piknoai-relay
docker version --format '{{.Server.Version}}'
docker compose version
docker run --rm --network none hello-world
systemctl is-active docker
docker ps --format '{{.Names}} {{.Status}}'
echo PIKNO_DOCKER_BOOTSTRAP_OK
