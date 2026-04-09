# Sophia Render Recovery

Use the repo-root `render.yaml` as the only active Render Blueprint.

This folder now contains manual recovery helpers only:

- `openclaw.render.json` — canonical Sophia seed config for Render recovery
- `bootstrap.sh` — optional Render Shell helper that copies the seed config to `$OPENCLAW_CONFIG_PATH` if the file is missing

Suggested recovery flow:

1. Back up `/data/.openclaw/openclaw.json`, `/data/.openclaw/credentials/`, `/data/.openclaw/agents/`, and `/data/.openclaw/sophia/`.
2. Sync the Render service from repo-root `render.yaml` on `main`.
3. Inspect `/data/.openclaw/openclaw.json`.
4. If you need to rebuild the config, seed `deploy/render/sophia-discord/openclaw.render.json` to `$OPENCLAW_CONFIG_PATH`.

Notes:

- The seed file is plain JSON so it is safe for both OpenClaw and the Docker runtime bootstrap path to read.
- Replace placeholder values like the WhatsApp allowlist phone number before using the seed in production.
