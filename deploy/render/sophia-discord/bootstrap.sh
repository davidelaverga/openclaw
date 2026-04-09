#!/usr/bin/env bash
# Sophia Discord + WhatsApp — Render first-boot config seeder
#
# Idempotent: copies the config template to the persistent disk only when
# no config file exists. Does NOT touch workspace, credentials, memory DB,
# or any other existing state.
#
# Usage: run once via Render Shell after deploying with the repo-root
# render.yaml blueprint.
#   bash /app/deploy/render/sophia-discord/bootstrap.sh

set -euo pipefail

CONFIG_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
CONFIG_FILE="${OPENCLAW_CONFIG_PATH:-$CONFIG_DIR/openclaw.json}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$SCRIPT_DIR/openclaw.render.json"

# Ensure state directory exists
mkdir -p "$CONFIG_DIR"

# Deploy config only when missing
if [ ! -f "$CONFIG_FILE" ]; then
  echo "[bootstrap] No config found at $CONFIG_FILE — deploying template"

  if [ ! -f "$TEMPLATE" ]; then
    echo "[bootstrap] ERROR: template not found at $TEMPLATE" >&2
    exit 1
  fi

  # The canonical seed is plain JSON so both OpenClaw and runtime bootstrap
  # helpers can read it safely.
  cp "$TEMPLATE" "$CONFIG_FILE"
  echo "[bootstrap] Config deployed to $CONFIG_FILE"
else
  echo "[bootstrap] Config already exists at $CONFIG_FILE — skipping"
fi

echo "[bootstrap] Done. Existing workspace, credentials, and memory are untouched."
