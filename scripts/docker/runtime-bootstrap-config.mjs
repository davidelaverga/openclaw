import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";

const DEFAULT_STATE_DIR = "/data/.openclaw";
const DEFAULT_CONFIG = {
  gateway: {
    mode: "local",
    controlUi: {
      dangerouslyAllowHostHeaderOriginFallback: true,
    },
  },
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getConfigPath(env = process.env) {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
  return env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "openclaw.json");
}

async function loadBundledPluginIds(rootDir) {
  if (!rootDir) {
    return new Set();
  }

  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    return new Set(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name),
    );
  } catch {
    return new Set();
  }
}

function ensureGatewayDefaults(config) {
  const gateway = isRecord(config.gateway) ? { ...config.gateway } : {};
  let changed = !isRecord(config.gateway);

  if (typeof gateway.mode !== "string" || gateway.mode.trim().length === 0) {
    gateway.mode = "local";
    changed = true;
  }

  const controlUi = isRecord(gateway.controlUi) ? { ...gateway.controlUi } : {};
  if (
    controlUi.dangerouslyAllowHostHeaderOriginFallback !== true &&
    !Array.isArray(controlUi.allowedOrigins)
  ) {
    controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
    changed = true;
  }

  if (changed) {
    gateway.controlUi = controlUi;
    config.gateway = gateway;
  }

  return changed;
}

function migrateLegacyDiscordNativeCommands(config) {
  const channels = isRecord(config.channels) ? config.channels : null;
  const discord = channels && isRecord(channels.discord) ? channels.discord : null;
  if (!discord || !isRecord(discord.nativeCommands)) {
    return false;
  }

  let changed = false;
  const commands = isRecord(discord.commands) ? { ...discord.commands } : {};
  const legacy = discord.nativeCommands;

  if (commands.native === undefined && legacy.enabled !== undefined) {
    commands.native = legacy.enabled;
    changed = true;
  }

  if (changed || !isRecord(discord.commands)) {
    discord.commands = commands;
  }

  delete discord.nativeCommands;
  return true;
}

function pruneStalePluginEntries(config, bundledPluginIds) {
  if (!isRecord(config.plugins) || !isRecord(config.plugins.entries)) {
    return false;
  }

  const nextEntries = {};
  let changed = false;

  for (const [pluginId, entry] of Object.entries(config.plugins.entries)) {
    if (bundledPluginIds.has(pluginId)) {
      nextEntries[pluginId] = entry;
      continue;
    }
    changed = true;
  }

  if (!changed) {
    return false;
  }

  if (Object.keys(nextEntries).length > 0) {
    config.plugins.entries = nextEntries;
    return true;
  }

  delete config.plugins.entries;
  if (Object.keys(config.plugins).length === 0) {
    delete config.plugins;
  }
  return true;
}

export async function bootstrapRuntimeConfig(env = process.env) {
  const configPath = getConfigPath(env);
  await mkdir(path.dirname(configPath), { recursive: true });

  let config = structuredClone(DEFAULT_CONFIG);
  let changed = false;

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON5.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error("expected top-level object");
    }
    config = parsed;
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
    if (code !== "ENOENT") {
      throw new Error(`Failed to parse ${configPath}: ${String(error)}`, { cause: error });
    }
    changed = true;
  }

  if (ensureGatewayDefaults(config)) {
    changed = true;
  }

  if (migrateLegacyDiscordNativeCommands(config)) {
    changed = true;
  }

  const bundledPluginIds = await loadBundledPluginIds(env.OPENCLAW_BUNDLED_PLUGINS_DIR);
  if (pruneStalePluginEntries(config, bundledPluginIds)) {
    changed = true;
  }

  if (changed) {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  return { changed, configPath, config };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { changed, configPath } = await bootstrapRuntimeConfig();
  if (changed) {
    console.log(`[bootstrap] normalized runtime config at ${configPath}`);
  }
}
