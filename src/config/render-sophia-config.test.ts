import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const seedPath = path.join(repoRoot, "deploy", "render", "sophia-discord", "openclaw.render.json");

describe("Sophia Render seed config", () => {
  it("stays valid JSON and matches the current core config schema", async () => {
    const raw = await readFile(seedPath, "utf8");
    const config = JSON.parse(raw);
    const result = OpenClawSchema.safeParse(config);

    expect(result.success, JSON.stringify(result.error?.issues ?? [], null, 2)).toBe(true);
  });

  it("uses the current Discord native command path and avoids seed-only plugin entries", async () => {
    const raw = await readFile(seedPath, "utf8");
    const config = JSON.parse(raw) as {
      channels?: { discord?: { commands?: { native?: unknown }; nativeCommands?: unknown } };
      plugins?: unknown;
    };

    expect(config.channels?.discord?.commands?.native).toBe(true);
    expect(config.channels?.discord?.nativeCommands).toBeUndefined();
    expect(config.plugins).toBeUndefined();
  });
});
