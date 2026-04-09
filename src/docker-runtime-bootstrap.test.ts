import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "docker", "runtime-bootstrap-config.mjs");

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runBootstrap(params: { configPath: string; bundledPluginsDir?: string }) {
  const result = spawnSync("node", [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: params.configPath,
      OPENCLAW_STATE_DIR: path.dirname(params.configPath),
      OPENCLAW_BUNDLED_PLUGINS_DIR: params.bundledPluginsDir ?? "",
    },
  });

  expect(result.status, result.stderr).toBe(0);
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) =>
        import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true })),
      ),
  );
});

describe("runtime bootstrap config", () => {
  it("creates a minimal local gateway config when the file is missing", async () => {
    const dir = await makeTempDir("openclaw-runtime-bootstrap-missing-");
    const configPath = path.join(dir, "state", "openclaw.json");

    await runBootstrap({ configPath });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config).toEqual({
      gateway: {
        mode: "local",
        controlUi: {
          dangerouslyAllowHostHeaderOriginFallback: true,
        },
      },
    });
  });

  it("parses JSON5 and repairs legacy Discord command config plus stale plugin entries", async () => {
    const dir = await makeTempDir("openclaw-runtime-bootstrap-json5-");
    const configPath = path.join(dir, "state", "openclaw.json");
    const pluginsDir = path.join(dir, "plugins");

    await mkdir(path.join(pluginsDir, "brave"), { recursive: true });
    await writeFile(path.join(pluginsDir, "brave", "openclaw.plugin.json"), '{"id":"brave"}\n');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `{
        // old Render config shape
        channels: {
          discord: {
            nativeCommands: { enabled: true },
          },
        },
        plugins: {
          entries: {
            brave: { enabled: true },
            missingPlugin: { enabled: true },
          },
        },
      }
      `,
    );

    await runBootstrap({ configPath, bundledPluginsDir: pluginsDir });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.gateway).toEqual({
      mode: "local",
      controlUi: {
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
    });
    expect(config.channels.discord.commands).toEqual({ native: true });
    expect(config.channels.discord.nativeCommands).toBeUndefined();
    expect(config.plugins.entries).toEqual({
      brave: { enabled: true },
    });
  });
});
