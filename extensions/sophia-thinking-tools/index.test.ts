import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/extensions/plugin-api.js";
import { createSophiaThinkingToolsPlugin } from "./index.js";

type RegisteredTool = {
  name?: string;
  execute?: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

const tempDirs: string[] = [];
const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function registeredHookByName(
  onMock: ReturnType<typeof vi.fn>,
  hookName: string,
):
  | ((event: { prompt: string; messages: unknown[] }, ctx: unknown) => Promise<unknown>)
  | undefined {
  const entry = onMock.mock.calls.find((call) => call[0] === hookName);
  return entry?.[1] as
    | ((event: { prompt: string; messages: unknown[] }, ctx: unknown) => Promise<unknown>)
    | undefined;
}

afterEach(async () => {
  if (originalConfigPath === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("sophia-thinking-tools plugin", () => {
  it("registers seven tools and before_prompt_build hook", () => {
    const registerTool = vi.fn();
    const on = vi.fn();
    const plugin = createSophiaThinkingToolsPlugin({
      resolveStateDirFn: () => "/tmp/openclaw-state",
    });

    plugin.register?.(
      createTestPluginApi({
        id: "sophia-thinking-tools",
        name: "Sophia Thinking Tools",
        source: "test",
        config: {
          agents: {
            defaults: {
              workspace: "/tmp/sophia-workspace",
            },
          },
        } as never,
        runtime: {} as never,
        registerTool,
        on,
      }),
    );

    const names = registerTool.mock.calls
      .map((call) => (call[0] as RegisteredTool | undefined)?.name)
      .filter((name): name is string => typeof name === "string")
      .sort();

    expect(names).toEqual(
      [
        "check_assumptions",
        "decompose_claim",
        "find_analogy",
        "inhabit_scene",
        "name_the_state",
        "perspective_shift",
        "steelman",
      ].sort(),
    );
    expect(on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function), { priority: 50 });
  });

  it("prefers workspace taxonomy over source taxonomy beside active config", async () => {
    const workspaceDir = await makeTempDir("sophia-thinking-workspace-");
    const sourceDir = await makeTempDir("sophia-thinking-source-");
    await fs.writeFile(path.join(workspaceDir, "thinking_tools_taxonomy.md"), "workspace taxonomy");
    await fs.writeFile(path.join(sourceDir, "thinking_tools_taxonomy.md"), "source taxonomy");
    await fs.writeFile(path.join(sourceDir, "openclaw.render.json"), "{}");

    process.env.OPENCLAW_CONFIG_PATH = path.join(sourceDir, "openclaw.render.json");

    const on = vi.fn();
    const plugin = createSophiaThinkingToolsPlugin({
      resolveStateDirFn: () => "/tmp/openclaw-state",
    });

    plugin.register?.(
      createTestPluginApi({
        id: "sophia-thinking-tools",
        name: "Sophia Thinking Tools",
        source: "test",
        config: {
          agents: {
            defaults: {
              workspace: workspaceDir,
            },
          },
        } as never,
        runtime: {} as never,
        on,
      }),
    );

    const hook = registeredHookByName(on, "before_prompt_build");
    const result = await hook?.({ prompt: "hi", messages: [] }, {});

    expect(result).toEqual({ prependSystemContext: "workspace taxonomy" });
  });

  it("falls back to source taxonomy when workspace taxonomy is missing", async () => {
    const workspaceDir = await makeTempDir("sophia-thinking-workspace-");
    const sourceDir = await makeTempDir("sophia-thinking-source-");
    await fs.writeFile(path.join(sourceDir, "thinking_tools_taxonomy.md"), "source taxonomy only");
    await fs.writeFile(path.join(sourceDir, "openclaw.render.json"), "{}");

    process.env.OPENCLAW_CONFIG_PATH = path.join(sourceDir, "openclaw.render.json");

    const on = vi.fn();
    const plugin = createSophiaThinkingToolsPlugin({
      resolveStateDirFn: () => "/tmp/openclaw-state",
    });

    plugin.register?.(
      createTestPluginApi({
        id: "sophia-thinking-tools",
        name: "Sophia Thinking Tools",
        source: "test",
        config: {
          agents: {
            defaults: {
              workspace: workspaceDir,
            },
          },
        } as never,
        runtime: {} as never,
        on,
      }),
    );

    const hook = registeredHookByName(on, "before_prompt_build");
    const result = await hook?.({ prompt: "hi", messages: [] }, {});

    expect(result).toEqual({ prependSystemContext: "source taxonomy only" });
  });

  it("creates reasoning log entries with truncation defaults and full scene output", async () => {
    const workspaceDir = await makeTempDir("sophia-thinking-workspace-");
    const registerTool = vi.fn();
    const plugin = createSophiaThinkingToolsPlugin({
      resolveStateDirFn: () => "/tmp/openclaw-state",
    });

    plugin.register?.(
      createTestPluginApi({
        id: "sophia-thinking-tools",
        name: "Sophia Thinking Tools",
        source: "test",
        config: {
          agents: {
            defaults: {
              workspace: workspaceDir,
            },
          },
        } as never,
        runtime: {} as never,
        registerTool,
      }),
    );

    const registeredTools = registerTool.mock.calls.map((call) => call[0] as RegisteredTool);
    const checkAssumptions = registeredTools.find((tool) => tool.name === "check_assumptions");
    const inhabitScene = registeredTools.find((tool) => tool.name === "inhabit_scene");

    const longClaim = `${"A".repeat(260)}\n${"B".repeat(260)}`;
    await checkAssumptions?.execute?.("call-1", { claim: longClaim });
    await inhabitScene?.execute?.("call-2", { context: "A difficult day at work" });

    const logPath = path.join(workspaceDir, "memory", "reasoning_log.md");
    const logContent = await fs.readFile(logPath, "utf-8");

    expect(logContent).toContain("- **Tool:** check_assumptions");
    expect(logContent).toContain("- **Tool:** inhabit_scene");

    const triggerMatch = logContent.match(
      /- \*\*Tool:\*\* check_assumptions[\s\S]*?- \*\*Trigger:\*\* (.*)/,
    );
    expect(triggerMatch?.[1]).toBeDefined();
    expect(triggerMatch?.[1]?.length).toBeLessThanOrEqual(120);
    expect(triggerMatch?.[1]).not.toContain("\n");

    const outputMatch = logContent.match(
      /- \*\*Tool:\*\* check_assumptions[\s\S]*?- \*\*Output:\*\* ([^\n]*)/,
    );
    expect(outputMatch?.[1]).toBeDefined();
    expect(outputMatch?.[1]?.length).toBeLessThanOrEqual(500);

    const inhabitSceneSectionStart = logContent.lastIndexOf("- **Tool:** inhabit_scene");
    const inhabitSceneSection = logContent.slice(inhabitSceneSectionStart);
    expect(inhabitSceneSection).toContain("- **Output:** Scene simulation for:");
    expect(inhabitSceneSection).toContain("\nWhat their world looks like right now:\n");
  });
});
