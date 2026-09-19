#!/usr/bin/env bash
# Arbor P0 environment wrapper.
#
# The host is Ubuntu 18.04 / glibc 2.27, which cannot run Node 24.
# This wrapper runs all toolchain commands inside the pinned image
# `arbor-node24:24.21.0` (Node 24.21.0 + pnpm 12.4.2), with the repo and a
# pnpm store on /data bind-mounted so nothing is written to the container.
#
# Usage:
#   source env.sh
#   arbor pnpm install
#   arbor pnpm check
#   arbor-shell        # interactive shell inside the container

ARBOR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARBOR_IMAGE="${ARBOR_IMAGE:-arbor-node24:24.21.0}"
ARBOR_PNPM_STORE="${ARBOR_PNPM_STORE:-/data/students/gaolei/tools/pnpm-store}"

mkdir -p "$ARBOR_PNPM_STORE"

arbor() {
  docker run --rm -i \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e npm_config_store_dir="$ARBOR_PNPM_STORE" \
    -v "$ARBOR_ROOT":"$ARBOR_ROOT" \
    -v "$ARBOR_PNPM_STORE":"$ARBOR_PNPM_STORE" \
    -w "$ARBOR_ROOT" \
    "$ARBOR_IMAGE" "$@"
}

arbor-shell() {
  arbor bash
}

export ARBOR_ROOT ARBOR_IMAGE ARBOR_PNPM_STORE
