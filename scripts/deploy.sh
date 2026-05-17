#!/usr/bin/env bash
#
# Rsync-based deploy helper for hosts where the project is NOT a git checkout.
# Prefer cloning the repo on the server and using `git pull` when possible
# (see DEPLOYMENT.md) — this script exists for the rsync workflow.
#
# Usage:
#   DEPLOY_HOST=user@host DEPLOY_PATH=~/luis/app ./scripts/deploy.sh           # sync only
#   DEPLOY_HOST=user@host DEPLOY_PATH=~/luis ./scripts/deploy.sh --rebuild      # sync + rebuild
#
# Env:
#   DEPLOY_HOST   ssh target, e.g. manu@servidorix            (required)
#   DEPLOY_PATH   remote project dir, e.g. ~/luis/app         (required)
#   COMPOSE_DIR   remote dir holding docker-compose.yml       (default: DEPLOY_PATH)
#
# Notes on the excludes below (lessons learned the hard way):
#  - `--exclude '/config'` is ANCHORED: it only excludes the top-level config/,
#    NOT src/infrastructure/config/. An unanchored `config` silently skips
#    load-config.js and breaks the deploy.
#  - `-c` forces a checksum comparison. `rsync -a` preserves mtimes, so its
#    default size+mtime quick-check can wrongly treat a stale remote file as
#    up to date and never transfer it.
set -euo pipefail

: "${DEPLOY_HOST:?Set DEPLOY_HOST, e.g. manu@servidorix}"
: "${DEPLOY_PATH:?Set DEPLOY_PATH, e.g. ~/luis/app}"
COMPOSE_DIR="${COMPOSE_DIR:-$DEPLOY_PATH}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

echo "==> Syncing $(pwd)/ -> ${DEPLOY_HOST}:${DEPLOY_PATH}/"
rsync -azc --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.karajan' \
  --exclude '.kj' \
  --exclude '.reviews' \
  --exclude '/config' \
  ./ "${DEPLOY_HOST}:${DEPLOY_PATH}/"
echo "==> Sync OK"

if [[ "${1:-}" == "--rebuild" ]]; then
  echo "==> Rebuilding on ${DEPLOY_HOST} (cd ${COMPOSE_DIR})"
  # shellcheck disable=SC2029
  ssh "${DEPLOY_HOST}" "cd ${COMPOSE_DIR} && docker compose build --no-cache && docker compose up -d --force-recreate"
  echo "==> Rebuild OK"
else
  echo "==> Skipping rebuild. To apply changes run, on ${DEPLOY_HOST}:"
  echo "    cd ${COMPOSE_DIR} && docker compose build --no-cache && docker compose up -d --force-recreate"
fi
