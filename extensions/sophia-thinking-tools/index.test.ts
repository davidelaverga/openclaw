import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/extensions/plugin-api.js";
import { createSophiaThinkingToolsPlugin } from "./index.js";

type RegisteredTool = {
  name?: string;
  execute?: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

const tempDirs: string[] = [];
const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
let originalFetch: typeof globalThis.fetch = globalThis.fetch;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function getRegisteredHook(
  onMock: ReturnType<typeof vi.fn>,
  hookName: string,
): ((event: unknown, ctx: unknown) => Promise<unknown> | unknown) | undefined {
  const entry = onMock.mock.calls.find((call) => call[0] === hookName);
  return entry?.[1] as ((event: unknown, ctx: unknown) => Promise<unknown> | unknown) | undefined;
}

function getRegisteredTool(
  registerToolMock: ReturnType<typeof vi.fn>,
  name: string,
): RegisteredTool | undefined {
  const tools = registerToolMock.mock.calls.map((call) => call[0] as RegisteredTool);
  return tools.find((tool) => tool.name === name);
}

function extractTextResult(result: unknown): string {
  const payload = result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const first = payload?.content?.[0];
  return typeof first?.text === "string" ? first.text : "";
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  if (originalConfigPath === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
  }

  if (originalOpenAiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  }

  if (originalAnthropicKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  }

  globalThis.fetch = originalFetch;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("sophia-thinking-tools plugin", () => {
  it("registers tools and lifecycle hooks", () => {
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
    expect(on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
    expect(on).toHaveBeenCalledWith("llm_output", expect.any(Function));
    expect(on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    expect(on).toHaveBeenCalledWith("session_end", expect.any(Function));
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

    const hook = getRegisteredHook(on, "before_prompt_build");
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

    const hook = getRegisteredHook(on, "before_prompt_build");
    const result = await hook?.({ prompt: "hi", messages: [] }, {});

    expect(result).toEqual({ prependSystemContext: "source taxonomy only" });
  });

  it("creates reasoning log entries with specialist metadata and full scene output", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

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

    const checkAssumptions = getRegisteredTool(registerTool, "check_assumptions");
    const inhabitScene = getRegisteredTool(registerTool, "inhabit_scene");

    const longClaim = `${"A".repeat(260)}\n${"B".repeat(260)}`;
    await checkAssumptions?.execute?.("call-1", { claim: longClaim });
    await inhabitScene?.execute?.("call-2", {
      scene: "They are leaving a difficult team meeting feeling exposed.",
      unspoken_weight: "Fear they are losing trust with peers.",
      likely_need: "Grounding plus a concrete next step.",
      tone_band_estimate: "Band 2 because stress is active and unresolved.",
    });

    const logPath = path.join(workspaceDir, "memory", "reasoning_log.md");
    const logContent = await fs.readFile(logPath, "utf-8");

    expect(logContent).toContain("- **Tool:** check_assumptions");
    expect(logContent).toContain("- **Tool:** inhabit_scene");
    expect(logContent).toContain("- **Specialist:** manual/manual-fallback (fallback)");
    expect(logContent).toContain("- **DurationMs:** 0");

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

    const sceneSectionStart = logContent.lastIndexOf("- **Tool:** inhabit_scene");
    const sceneSection = logContent.slice(sceneSectionStart);
    expect(sceneSection).toContain("- **Output:** SCENE CONFIRMED");
    expect(sceneSection).toContain("POST-SCENE EVALUATION");
  });

  it("enforces scene-tool order in before_tool_call and resets on llm_output", async () => {
    const on = vi.fn();
    const plugin = createSophiaThinkingToolsPlugin({
      resolveStateDirFn: () => "/tmp/openclaw-state",
    });

    plugin.register?.(
      createTestPluginApi({
        id: "sophia-thinking-tools",
        name: "Sophia Thinking Tools",
        source: "test",
        config: {} as never,
        runtime: {} as never,
        on,
      }),
    );

    const beforeToolCall = getRegisteredHook(on, "before_tool_call");
    const llmOutput = getRegisteredHook(on, "llm_output");
    expect(beforeToolCall).toBeDefined();
    expect(llmOutput).toBeDefined();

    const blockedPerspective = await beforeToolCall?.(
      { toolName: "perspective_shift", params: {}, runId: "run-1" },
      { toolName: "perspective_shift", runId: "run-1", sessionId: "session-a" },
    );
    expect(blockedPerspective).toEqual({
      block: true,
      blockReason: "perspective_shift requires inhabit_scene first in the same run",
    });

    const blockedState = await beforeToolCall?.(
      { toolName: "name_the_state", params: {}, runId: "run-2" },
      { toolName: "name_the_state", runId: "run-2", sessionId: "session-a" },
    );
    expect(blockedState).toEqual({
      block: true,
      blockReason: "name_the_state requires inhabit_scene first in the same run",
    });

    const allowInhabit = await beforeToolCall?.(
      { toolName: "inhabit_scene", params: {}, runId: "run-3" },
      { toolName: "inhabit_scene", runId: "run-3", sessionId: "session-a" },
    );
    expect(allowInhabit).toBeUndefined();

    const allowPerspective = await beforeToolCall?.(
      { toolName: "perspective_shift", params: {}, runId: "run-3" },
      { toolName: "perspective_shift", runId: "run-3", sessionId: "session-a" },
    );
    expect(allowPerspective).toBeUndefined();

    const allowState = await beforeToolCall?.(
      { toolName: "name_the_state", params: {}, runId: "run-3" },
      { toolName: "name_the_state", runId: "run-3", sessionId: "session-a" },
    );
    expect(allowState).toBeUndefined();

    await llmOutput?.({ runId: "run-3" }, {});

    const blockedAfterReset = await beforeToolCall?.(
      { toolName: "name_the_state", params: {}, runId: "run-3" },
      { toolName: "name_the_state", runId: "run-3", sessionId: "session-a" },
    );
    expect(blockedAfterReset).toEqual({
      block: true,
      blockReason: "name_the_state requires inhabit_scene first in the same run",
    });
  });

  it("preserves other active run state when agent_end provides a specific run id", async () => {
    const on = vi.fn();
    const plugin = createSophiaThinkingToolsPlugin({
      resolveStateDirFn: () => "/tmp/openclaw-state",
    });

    plugin.register?.(
      createTestPluginApi({
        id: "sophia-thinking-tools",
        name: "Sophia Thinking Tools",
        source: "test",
        config: {} as never,
        runtime: {} as never,
        on,
      }),
    );

    const beforeToolCall = getRegisteredHook(on, "before_tool_call");
    const agentEnd = getRegisteredHook(on, "agent_end");
    const sessionEnd = getRegisteredHook(on, "session_end");
    expect(beforeToolCall).toBeDefined();
    expect(agentEnd).toBeDefined();
    expect(sessionEnd).toBeDefined();

    await beforeToolCall?.(
      { toolName: "inhabit_scene", params: {}, runId: "run-a" },
      { toolName: "inhabit_scene", runId: "run-a", sessionId: "session-a" },
    );
    await beforeToolCall?.(
      { toolName: "inhabit_scene", params: {}, runId: "run-b" },
      { toolName: "inhabit_scene", runId: "run-b", sessionId: "session-a" },
    );

    await agentEnd?.(
      { messages: [], success: true, runId: "run-a" },
      { toolName: "inhabit_scene", sessionId: "session-a" },
    );

    const runBStillAllowed = await beforeToolCall?.(
      { toolName: "perspective_shift", params: {}, runId: "run-b" },
      { toolName: "perspective_shift", runId: "run-b", sessionId: "session-a" },
    );
    expect(runBStillAllowed).toBeUndefined();

    const runABlockedAfterCleanup = await beforeToolCall?.(
      { toolName: "perspective_shift", params: {}, runId: "run-a" },
      { toolName: "perspective_shift", runId: "run-a", sessionId: "session-a" },
    );
    expect(runABlockedAfterCleanup).toEqual({
      block: true,
      blockReason: "perspective_shift requires inhabit_scene first in the same run",
    });

    await sessionEnd?.({ sessionId: "session-a" }, { sessionId: "session-a" });
    const runBBlockedAfterSessionEnd = await beforeToolCall?.(
      { toolName: "perspective_shift", params: {}, runId: "run-b" },
      { toolName: "perspective_shift", runId: "run-b", sessionId: "session-a" },
    );
    expect(runBBlockedAfterSessionEnd).toEqual({
      block: true,
      blockReason: "perspective_shift requires inhabit_scene first in the same run",
    });
  });

  it("uses configured anthropic primary specialist settings", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "configured anthropic primary output" }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const registerTool = vi.fn();
    const plugin = createSophiaThinkingToolsPlugin({
      resolveStateDirFn: () => "/tmp/openclaw-state",
    });

    plugin.register?.(
      createTestPluginApi({
        id: "sophia-thinking-tools",
        name: "Sophia Thinking Tools",
        source: "test",
        config: {} as never,
        runtime: {} as never,
        pluginConfig: {
          specialist: {
            primary: {
              provider: "anthropic",
              model: "claude-custom-primary",
              timeoutMs: 9000,
              maxOutputTokens: 333,
            },
            fallback: {
              provider: "openai",
              model: "gpt-fallback",
              reasoningEffort: "medium",
              timeoutMs: 4000,
              maxOutputTokens: 120,
            },
          },
        },
        registerTool,
      }),
    );

    const steelman = getRegisteredTool(registerTool, "steelman");
    const result = await steelman?.execute?.("call-1", {
      position: "Remote-first teams are less productive.",
    });
    expect(extractTextResult(result)).toBe("configured anthropic primary output");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("claude-custom-primary");
    expect(body.max_tokens).toBe(333);
  });

  it("uses provider default model when provider override omits model", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "provider default model output" }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const registerTool = vi.fn();
    const plugin = createSophiaThinkingToolsPlugin({
      resolveStateDirFn: () => "/tmp/openclaw-state",
    });

    plugin.register?.(
      createTestPluginApi({
        id: "sophia-thinking-tools",
        name: "Sophia Thinking Tools",
        source: "test",
        config: {} as never,
        runtime: {} as never,
        pluginConfig: {
          specialist: {
            primary: {
              provider: "anthropic",
            },
          },
        },
        registerTool,
      }),
    );

    const checkAssumptions = getRegisteredTool(registerTool, "check_assumptions");
    const result = await checkAssumptions?.execute?.("call-1", {
      claim: "All remote teams lose velocity.",
    });
    expect(extractTextResult(result)).toBe("provider default model output");

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("claude-opus-4-6");
  });

  it("falls back to configured anthropic secondary when primary openai is unavailable", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "anthropic-fallback-key";

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "fallback anthropic output" }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const registerTool = vi.fn();
    const plugin = createSophiaThinkingToolsPlugin({
      resolveStateDirFn: () => "/tmp/openclaw-state",
    });

    plugin.register?.(
      createTestPluginApi({
        id: "sophia-thinking-tools",
        name: "Sophia Thinking Tools",
        source: "test",
        config: {} as never,
        runtime: {} as never,
        pluginConfig: {
          specialist: {
            primary: {
              provider: "openai",
              model: "gpt-custom-primary",
              reasoningEffort: "high",
              timeoutMs: 9000,
              maxOutputTokens: 333,
            },
            fallback: {
              provider: "anthropic",
              model: "claude-custom-fallback",
              timeoutMs: 7000,
              maxOutputTokens: 280,
            },
          },
        },
        registerTool,
      }),
    );

    const decomposeClaim = getRegisteredTool(registerTool, "decompose_claim");
    const result = await decomposeClaim?.execute?.("call-2", {
      claim: "AI makes all teams faster.",
    });
    expect(extractTextResult(result)).toBe("fallback anthropic output");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("claude-custom-fallback");
    expect(body.max_tokens).toBe(280);
  });
});
