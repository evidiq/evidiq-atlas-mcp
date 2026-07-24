#!/usr/bin/env bash
# Deploy EVIDIQ Atlas as a Docker container behind the shared Coolify Traefik
# proxy on the mcp.evidiq.dev box. Routed by PathPrefix(/atlas) with the prefix
# stripped, so the container still sees /mcp, /x402, /health. Secrets come from
# the env file, never baked into the image. Mirrors the sibling MCP deploys.
set -euo pipefail

IMAGE="${IMAGE:-evidiq-atlas:latest}"
NAME="${NAME:-evidiq-atlas}"
NETWORK="${NETWORK:-coolify}"
ENV_FILE="${ENV_FILE:-/root/evidiq-atlas.env}"
HOST_PORT="${HOST_PORT:-3004}"

docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  --network "$NETWORK" \
  --env-file "$ENV_FILE" \
  -p 127.0.0.1:${HOST_PORT}:3000 \
  --label 'traefik.enable=true' \
  --label 'traefik.http.middlewares.atlas-strip.stripprefix.prefixes=/atlas' \
  --label 'traefik.http.routers.atlas.middlewares=atlas-strip' \
  --label 'traefik.http.routers.atlas.rule=Host(`mcp.evidiq.dev`) && PathPrefix(`/atlas`)' \
  --label 'traefik.http.routers.atlas.tls=true' \
  --label 'traefik.http.routers.atlas.tls.certresolver=letsencrypt' \
  --label 'traefik.http.services.atlas.loadbalancer.server.port=3000' \
  "$IMAGE"

echo "started:"
docker ps --filter "name=^/${NAME}$" --format '{{.Names}}  {{.Status}}'
