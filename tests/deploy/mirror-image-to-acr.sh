#!/usr/bin/env bash
#
# Mirror an already published codebuddy2api image into Aliyun ACR.
#
# The GitHub workflow does this automatically (job `publish-acr`) whenever the
# ACR_USERNAME / ACR_PASSWORD repository secrets are configured. This script is
# the manual fallback: run it from a machine that is logged in to ACR.
#
# Usage:
#   tests/deploy/mirror-image-to-acr.sh <version|tag> [extra-tag...]
#
# Examples:
#   tests/deploy/mirror-image-to-acr.sh 1.2.2 latest
#   SOURCE_REGISTRY=ghcr.io/hddara/codebuddy2api tests/deploy/mirror-image-to-acr.sh 1.2.2
#
# Requirements: docker with the buildx plugin and jq, plus
# `docker login registry.cn-hangzhou.aliyuncs.com` beforehand.
set -euo pipefail

SOURCE_REGISTRY="${SOURCE_REGISTRY:-ghcr.nju.edu.cn/hddara/codebuddy2api}"
ACR_IMAGE="${ACR_IMAGE:-registry.cn-hangzhou.aliyuncs.com/hucx/codebuddy2api}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <version|tag> [extra-tag...]" >&2
  exit 1
fi

version="$1"
shift
tags=("$version" "$@")

# Buildx attaches provenance attestations to the published index, and ACR
# rejects those manifests (403 "unknown manifest class for
# application/vnd.oci.empty.v1+json"), so the index is rebuilt from the
# platform manifests only. The platform digests stay identical to the source.
sources=()
while read -r digest; do
  [[ -n "$digest" ]] && sources+=("${SOURCE_REGISTRY}@${digest}")
done < <(docker buildx imagetools inspect "${SOURCE_REGISTRY}:${version}" --raw \
  | jq -r '.manifests[]? | select((.platform.architecture // "") != "unknown") | .digest')

if [[ ${#sources[@]} -eq 0 ]]; then
  echo "No platform manifests found for ${SOURCE_REGISTRY}:${version}" >&2
  exit 1
fi

targets=()
for tag in "${tags[@]}"; do
  targets+=("-t" "${ACR_IMAGE}:${tag}")
done

echo "Mirroring ${SOURCE_REGISTRY}:${version} to ${ACR_IMAGE} (${tags[*]})"
docker buildx imagetools create "${targets[@]}" "${sources[@]}"
docker buildx imagetools inspect "${ACR_IMAGE}:${version}"
