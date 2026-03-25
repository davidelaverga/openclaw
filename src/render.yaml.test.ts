import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type RenderEnvVar = {
  key?: string;
  value?: string;
};

type RenderService = {
  name?: string;
  runtime?: string;
  envVars?: RenderEnvVar[];
};

type RenderBlueprint = {
  services?: RenderService[];
};

describe("render.yaml", () => {
  it("keeps the Render deployment configured to install the browser and load Sophia's repo config", async () => {
    const raw = await readFile(resolve(repoRoot, "render.yaml"), "utf8");
    const blueprint = parse(raw) as RenderBlueprint;
    const openclawService = blueprint.services?.find((service) => service.name === "openclaw");

    expect(openclawService?.runtime).toBe("docker");
    expect(openclawService?.envVars).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "OPENCLAW_INSTALL_BROWSER", value: "1" }),
        expect.objectContaining({
          key: "OPENCLAW_CONFIG_PATH",
          value: "/app/sophia/openclaw.render.json",
        }),
      ]),
    );
  });
});
