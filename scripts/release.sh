#!/usr/bin/env bash
# Publish a release image and point every deployment manifest at it.
#
# Usage: scripts/release.sh [--tag YYYYMMDD.TNN] [--no-commit]
#
# The tag defaults to today plus the first free sequence number. Everything this
# script does was previously a paragraph of tribal knowledge that every session
# rediscovered: the ACR image name, the tag scheme, the `--provenance=false`
# flag without which the push is refused, and the three manifests that carry the
# tag. See the "Release" section of AGENTS.md.
set -euo pipefail

IMAGE='registry.cn-hangzhou.aliyuncs.com/hucx/codebuddy2api'
MANIFESTS=(
  deploy/swarm-stack.yml
  deploy/docker-compose.yml
  deploy/k8s/codebuddy2api.yaml
)

TAG=''
COMMIT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      TAG="$2"
      shift 2
      ;;
    --no-commit)
      COMMIT=0
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

cd "$(dirname "$0")/.."

# Buildx keeps its state under ~/.docker, which the agent sandbox refuses to
# write. Keeping it inside the repository makes the build work under the same
# restrictions as every other command here.
export BUILDX_CONFIG="${BUILDX_CONFIG:-$PWD/.tmp-buildx}"
mkdir -p "$BUILDX_CONFIG"

if [ -z "$TAG" ]; then
  base="$(date +%Y%m%d)"
  seq=1
  while docker buildx imagetools inspect "$IMAGE:$base.T0$seq" >/dev/null 2>&1; do
    seq=$((seq + 1))
    if [ "$seq" -gt 9 ]; then
      echo "no free $base.TNN tag" >&2
      exit 1
    fi
  done
  TAG="$base.T0$seq"
fi

echo "==> building $IMAGE:$TAG (linux/amd64)"

# ACR refuses the attestation manifest buildx attaches by default:
#   denied: unknown manifest class for application/vnd.oci.empty.v1+json
# so provenance and SBOM are switched off, not merely cosmetic options.
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  -t "$IMAGE:$TAG" \
  --push \
  .

echo "==> verifying the push"
docker buildx imagetools inspect "$IMAGE:$TAG"

echo "==> pointing the manifests at $TAG"
for manifest in "${MANIFESTS[@]}"; do
  perl -0pi -e "s{\Q$IMAGE\E:[0-9]{8}\.T[0-9]{2}}{$IMAGE:$TAG}g" "$manifest"
  printf '    %s -> %s\n' "$manifest" "$(grep -o "$IMAGE:[0-9]*\\.T[0-9]*" "$manifest" | head -1)"
done

if [ "$COMMIT" = '1' ]; then
  git add "${MANIFESTS[@]}"
  git commit -m "chore(release): point the deployment manifests at $TAG"
  git push origin HEAD
fi

cat <<EOF

==> image published: $IMAGE:$TAG

The Swarm service still runs the previous tag until the server is updated.
Run this where the swarm manager lives (docker stack deploy has no env_file
support, so every variable has to be exported in that shell first):

  cd <server repo path> && git pull
  export CODEBUDDY_STORAGE_BACKEND=pg DATABASE_URL='...' \\
         CODEBUDDY_STORAGE_ENCRYPTION_KEY='...' CODEBUDDY_PASSWORD='...' \\
         CODEBUDDY_GATEWAY_AUTH=password
  docker stack deploy -c deploy/swarm-stack.yml codebuddy2api
  docker service ps codebuddy2api_app

Rollback: set the manifests back to the previous tag and redeploy.
EOF
