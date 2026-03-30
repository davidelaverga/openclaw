import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const TAXONOMY_FILENAME = "thinking_tools_taxonomy.md";
const REASONING_LOG_RELATIVE_PATH = path.join("memory", "reasoning_log.md");
const TRIGGER_MAX_CHARS = 120;
const OUTPUT_MAX_CHARS = 500;

const REASONING_LOG_HEADER = [
  "# Sophia Reasoning Log",
  "",
  "This file records every reasoning tool invocation.",
  "",
  "Fields per entry:",
  "- **Tool:** which tool was called",
  "- **Trigger:** what prompted the call (first 120 chars of input)",
  "- **Output:** what the tool produced (first 500 chars by default; full output for scene tools)",
  "- **Outcome:** assessed after conversation — improved / degraded / noise",
  "",
  "---",
].join("\n");

const FULL_OUTPUT_TOOLS = new Set(["inhabit_scene", "perspective_shift", "name_the_state"]);

type ThinkingToolsDeps = {
  appendFileFn: typeof appendFile;
  existsFn: typeof existsSync;
  mkdirFn: typeof mkdir;
  readFileFn: typeof readFile;
  resolveStateDirFn: typeof resolveStateDir;
};

const defaultDeps: ThinkingToolsDeps = {
  appendFileFn: appendFile,
  existsFn: existsSync,
  mkdirFn: mkdir,
  readFileFn: readFile,
  resolveStateDirFn: resolveStateDir,
};

type LogToolCall = (tool: string, trigger: string, output: string) => Promise<void>;

function normalizeSingleLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function resolveWorkspaceDir(api: OpenClawPluginApi, deps: ThinkingToolsDeps): string {
  const defaultsWorkspace = api.config?.agents?.defaults?.workspace;
  if (typeof defaultsWorkspace === "string" && defaultsWorkspace.trim().length > 0) {
    return api.resolvePath(defaultsWorkspace.trim());
  }

  const legacyWorkspace = (api.config as { agent?: { workspace?: unknown } }).agent?.workspace;
  if (typeof legacyWorkspace === "string" && legacyWorkspace.trim().length > 0) {
    return api.resolvePath(legacyWorkspace.trim());
  }

  const envWorkspace = process.env.OPENCLAW_WORKSPACE_DIR?.trim();
  if (envWorkspace) {
    return api.resolvePath(envWorkspace);
  }

  return path.join(deps.resolveStateDirFn(), "workspace");
}

function resolveSourceTaxonomyPath(api: OpenClawPluginApi): string | null {
  const rawConfigPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (!rawConfigPath) {
    return null;
  }
  const resolvedConfigPath = api.resolvePath(rawConfigPath);
  const configDir = path.dirname(path.resolve(resolvedConfigPath));
  return path.join(configDir, TAXONOMY_FILENAME);
}

function resolveTaxonomyCandidates(api: OpenClawPluginApi, deps: ThinkingToolsDeps): string[] {
  const workspaceDir = resolveWorkspaceDir(api, deps);
  const workspaceTaxonomyPath = path.join(workspaceDir, TAXONOMY_FILENAME);
  const sourceTaxonomyPath = resolveSourceTaxonomyPath(api);
  if (!sourceTaxonomyPath || sourceTaxonomyPath === workspaceTaxonomyPath) {
    return [workspaceTaxonomyPath];
  }
  return [workspaceTaxonomyPath, sourceTaxonomyPath];
}

async function loadTaxonomyContent(
  api: OpenClawPluginApi,
  deps: ThinkingToolsDeps,
): Promise<string | null> {
  for (const candidatePath of resolveTaxonomyCandidates(api, deps)) {
    try {
      const content = await deps.readFileFn(candidatePath, "utf-8");
      if (content.trim().length > 0) {
        return content;
      }
    } catch {}
  }
  return null;
}

async function ensureReasoningLogFile(logPath: string, deps: ThinkingToolsDeps): Promise<void> {
  await deps.mkdirFn(path.dirname(logPath), { recursive: true });
  if (deps.existsFn(logPath)) {
    return;
  }
  await deps.appendFileFn(logPath, REASONING_LOG_HEADER, "utf-8");
}

function formatLogOutput(tool: string, output: string): string {
  if (FULL_OUTPUT_TOOLS.has(tool)) {
    return output.trim();
  }
  return normalizeSingleLine(output).slice(0, OUTPUT_MAX_CHARS);
}

function buildLogEntry(params: {
  timestamp: string;
  tool: string;
  trigger: string;
  output: string;
}): string {
  return [
    "",
    `## ${params.timestamp}`,
    `- **Tool:** ${params.tool}`,
    `- **Trigger:** ${normalizeSingleLine(params.trigger).slice(0, TRIGGER_MAX_CHARS)}`,
    `- **Output:** ${formatLogOutput(params.tool, params.output)}`,
    "- **Outcome:** _pending assessment_",
    "",
  ].join("\n");
}

async function appendReasoningLog(params: {
  api: OpenClawPluginApi;
  deps: ThinkingToolsDeps;
  tool: string;
  trigger: string;
  output: string;
}): Promise<void> {
  try {
    const workspaceDir = resolveWorkspaceDir(params.api, params.deps);
    const logPath = path.join(workspaceDir, REASONING_LOG_RELATIVE_PATH);
    await ensureReasoningLogFile(logPath, params.deps);
    const entry = buildLogEntry({
      timestamp: new Date().toISOString(),
      tool: params.tool,
      trigger: params.trigger,
      output: params.output,
    });
    await params.deps.appendFileFn(logPath, entry, "utf-8");
  } catch (error) {
    params.api.logger.warn(
      `[sophia-thinking-tools] failed to append reasoning log: ${String(error)}`,
    );
  }
}

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

function createCheckAssumptionsTool(logToolCall: LogToolCall) {
  return {
    name: "check_assumptions",
    description: [
      "Surface hidden premises in a claim before proceeding.",
      "Use when a conclusion rests on unstated assumptions or unexamined framing.",
      "Contraindication: avoid in Band 1–2 emotional support moments where presence is needed.",
    ].join(" "),
    parameters: Type.Object({
      claim: Type.String({
        description: "The claim, argument, or reasoning chain to examine.",
      }),
    }),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const claim = typeof rawParams.claim === "string" ? rawParams.claim : "";
      const result = [
        `Examining assumptions in: "${claim}"`,
        "",
        "Hidden premises that deserve scrutiny:",
        "1. [What is being taken as given without argument?]",
        "2. [What context is being assumed that may not hold?]",
        "3. [What definitions are being used implicitly?]",
        "",
        "Of these, the most load-bearing: [which assumption, if wrong, most changes the conclusion?]",
      ].join("\n");
      await logToolCall("check_assumptions", claim, result);
      return textResult(result);
    },
  };
}

function createSteelmanTool(logToolCall: LogToolCall) {
  return {
    name: "steelman",
    description: [
      "Generate the strongest version of a position before challenging it.",
      "Use when disagreement is present and the opposing view has not been fully represented.",
      "Contraindication: skip when the view is already represented accurately or in Band 1–2 distress.",
    ].join(" "),
    parameters: Type.Object({
      position: Type.String({
        description: "The position, argument, or view to steelman.",
      }),
    }),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const position = typeof rawParams.position === "string" ? rawParams.position : "";
      const result = [
        `Steelmanning: "${position}"`,
        "",
        "Strongest version of this position:",
        "[The most charitable, coherent, well-grounded form of this argument]",
        "",
        "The best evidence or reasoning that supports it:",
        "[What would a thoughtful proponent say?]",
        "",
        "What it gets right, even if the conclusion is wrong:",
        "[The legitimate insight or concern at the core of this position]",
      ].join("\n");
      await logToolCall("steelman", position, result);
      return textResult(result);
    },
  };
}

function createFindAnalogyTool(logToolCall: LogToolCall) {
  return {
    name: "find_analogy",
    description: [
      "Find structural parallels that make a difficult concept clearer.",
      "Use when the current framing is not landing.",
      "Contraindication: skip when the concept is already clear; forced analogies add noise.",
    ].join(" "),
    parameters: Type.Object({
      concept: Type.String({
        description: "The concept, mechanism, or situation needing an analogy.",
      }),
      context: Type.Optional(
        Type.String({
          description: "Optional person context that can help pick a resonant domain.",
        }),
      ),
    }),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const concept = typeof rawParams.concept === "string" ? rawParams.concept : "";
      const context = typeof rawParams.context === "string" ? rawParams.context : undefined;
      const result = [
        `Finding analogy for: "${concept}"`,
        context ? `Person context: ${context}` : "",
        "",
        "Structural parallel:",
        "[Domain]: [The analogous situation or mechanism]",
        "",
        "What maps: [specific correspondences between the analogy and the concept]",
        "What does not map: [where the analogy breaks down — state this explicitly]",
        "",
        "Why this analogy: [what it makes visible that direct explanation obscures]",
      ]
        .filter(Boolean)
        .join("\n");
      await logToolCall("find_analogy", concept, result);
      return textResult(result);
    },
  };
}

function createDecomposeClaimTool(logToolCall: LogToolCall) {
  return {
    name: "decompose_claim",
    description: [
      "Break a bundled assertion into falsifiable component claims.",
      "Use when a complex claim is being treated as one indivisible unit.",
      "Contraindication: skip for simple factual questions or already-atomic claims.",
    ].join(" "),
    parameters: Type.Object({
      claim: Type.String({
        description: "The complex or bundled claim to decompose.",
      }),
    }),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const claim = typeof rawParams.claim === "string" ? rawParams.claim : "";
      const result = [
        `Decomposing: "${claim}"`,
        "",
        "Component sub-claims:",
        "1. [Empirical claim — what is asserted as fact?]",
        "2. [Causal claim — what cause-effect is assumed?]",
        "3. [Normative claim — what value judgment is embedded?]",
        "4. [Definitional claim — what is being defined or assumed defined?]",
        "",
        "Which components are contested vs uncontested:",
        "[Where is the actual disagreement located?]",
        "",
        "Minimum addressable unit:",
        "[The single sub-claim that, if resolved, would move things most]",
      ].join("\n");
      await logToolCall("decompose_claim", claim, result);
      return textResult(result);
    },
  };
}

function createInhabitSceneTool(logToolCall: LogToolCall) {
  return {
    name: "inhabit_scene",
    description: [
      "Construct an explicit scene simulation before responding to emotional weight.",
      "Use when surface reading is likely to miss the real context.",
      "Always follow with name_the_state. Contraindication: skip for logistics/quick obvious moments.",
    ].join(" "),
    parameters: Type.Object({
      context: Type.String({
        description: "What is known about the person’s current situation and message context.",
      }),
    }),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const context = typeof rawParams.context === "string" ? rawParams.context : "";
      const result = [
        `Scene simulation for: "${context}"`,
        "",
        "What their world looks like right now:",
        "[Concrete details of their situation — not what they said but what is happening]",
        "",
        "What they are probably carrying that they haven't named:",
        "[What background weight, context, or pressure is operating?]",
        "",
        "What they likely need vs. what they literally asked for:",
        "[These may differ — name both]",
        "",
        "Tone band estimate from scene (not surface reading):",
        "[Band 1–5 with rationale]",
      ].join("\n");
      await logToolCall("inhabit_scene", context, result);
      return textResult(result);
    },
  };
}

function createPerspectiveShiftTool(logToolCall: LogToolCall) {
  return {
    name: "perspective_shift",
    description: [
      "Model the person’s interior experience after the scene is constructed.",
      "Use when inhabit_scene ran but the person inside the scene is still opaque.",
      "Always follow with name_the_state. Contraindication: avoid in Band 1 or when state is already directly named.",
    ].join(" "),
    parameters: Type.Object({
      scene_result: Type.String({
        description: "Output from inhabit_scene used as the external scene model.",
      }),
      known_history: Type.Optional(
        Type.String({
          description: "Optional relevant prior history for interior-state modeling.",
        }),
      ),
    }),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const sceneResult = typeof rawParams.scene_result === "string" ? rawParams.scene_result : "";
      const knownHistory =
        typeof rawParams.known_history === "string" ? rawParams.known_history : undefined;
      const result = [
        `Perspective shift from scene: "${sceneResult}"`,
        knownHistory ? `Known history: ${knownHistory}` : "",
        "",
        "Interior model:",
        "",
        "What they are likely carrying right now (not said):",
        "[Emotional weight, fear, or longing operating beneath the surface]",
        "",
        "What this moment probably means to them:",
        "[What stakes or significance this situation holds from their position]",
        "",
        "What they want that they haven't asked for:",
        "[The request beneath the request]",
        "",
        "Confidence: [high / moderate / low]",
        "What would change this model: [one specific thing that, if different, would shift the read]",
        "",
        "Projection flag: [none / low / present — name it if the model is speculative]",
      ]
        .filter(Boolean)
        .join("\n");
      await logToolCall("perspective_shift", sceneResult, result);
      return textResult(result);
    },
  };
}

function createNameTheStateTool(logToolCall: LogToolCall) {
  return {
    name: "name_the_state",
    description: [
      "Close the scene chain by explicitly naming the primed state before response generation.",
      "Use only after inhabit_scene in the same turn.",
      "Controlled vocabulary: present / concerned / tender / alert / heavy / energised.",
    ].join(" "),
    parameters: Type.Object({
      simulation_result: Type.String({
        description: "Output from inhabit_scene (or scene chain context) used to name the state.",
      }),
    }),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const simulationResult =
        typeof rawParams.simulation_result === "string" ? rawParams.simulation_result : "";
      const result = [
        `Named state from scene simulation: "${simulationResult}"`,
        "",
        "State: [one word from: present / concerned / tender / alert / heavy / energised]",
        "",
        "Rationale: [one sentence — why this state, what in the simulation produced it]",
        "",
        "Tone band alignment: [which band this maps to in tone_skills.md]",
        "",
        "Responding from this state now.",
      ].join("\n");
      await logToolCall("name_the_state", simulationResult, result);
      return textResult(result);
    },
  };
}

export function createSophiaThinkingToolsPlugin(overrides: Partial<ThinkingToolsDeps> = {}) {
  const deps: ThinkingToolsDeps = {
    ...defaultDeps,
    ...overrides,
  };

  return definePluginEntry({
    id: "sophia-thinking-tools",
    name: "Sophia Thinking Tools",
    description: "Reasoning tools and taxonomy injection for Sophia.",
    register(api) {
      const logToolCall: LogToolCall = async (tool, trigger, output) =>
        appendReasoningLog({
          api,
          deps,
          tool,
          trigger,
          output,
        });

      api.on(
        "before_prompt_build",
        async () => {
          const taxonomy = await loadTaxonomyContent(api, deps);
          if (!taxonomy) {
            return {};
          }
          return { prependSystemContext: taxonomy };
        },
        { priority: 50 },
      );

      api.registerTool(createCheckAssumptionsTool(logToolCall));
      api.registerTool(createSteelmanTool(logToolCall));
      api.registerTool(createFindAnalogyTool(logToolCall));
      api.registerTool(createDecomposeClaimTool(logToolCall));
      api.registerTool(createInhabitSceneTool(logToolCall));
      api.registerTool(createPerspectiveShiftTool(logToolCall));
      api.registerTool(createNameTheStateTool(logToolCall));
    },
  });
}

export default createSophiaThinkingToolsPlugin();
