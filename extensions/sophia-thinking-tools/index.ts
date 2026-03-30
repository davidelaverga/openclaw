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
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60000;
const MIN_MAX_OUTPUT_TOKENS = 64;
const MAX_MAX_OUTPUT_TOKENS = 4000;

const REASONING_LOG_HEADER = [
  "# Sophia Reasoning Log",
  "",
  "This file records every reasoning tool invocation.",
  "",
  "Fields per entry:",
  "- **Tool:** which tool was called",
  "- **Trigger:** what prompted the call (first 120 chars of input)",
  "- **Specialist:** provider/model and whether primary or fallback was used (intellectual tools)",
  "- **DurationMs:** specialist latency in milliseconds (intellectual tools)",
  "- **Output:** what the tool produced (first 500 chars by default; full output for scene tools)",
  "- **Outcome:** assessed after conversation — improved / degraded / noise",
  "",
  "---",
].join("\n");

const FULL_OUTPUT_TOOLS = new Set(["inhabit_scene", "perspective_shift", "name_the_state"]);
const SCENE_STATES = ["present", "concerned", "tender", "alert", "heavy", "energised"] as const;
const SCENE_CONFIDENCE_LEVELS = ["high", "moderate", "low"] as const;
const PROJECTION_FLAGS = ["none", "low", "present"] as const;

type SceneState = (typeof SCENE_STATES)[number];
type SceneConfidenceLevel = (typeof SCENE_CONFIDENCE_LEVELS)[number];
type ProjectionFlag = (typeof PROJECTION_FLAGS)[number];

type SpecialistProvider = "openai" | "anthropic";
type SpecialistSource = SpecialistProvider | "manual";
type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
type SpecialistTier = "primary" | "fallback";

type SpecialistEndpointConfig = {
  provider: SpecialistProvider;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  reasoningEffort?: OpenAIReasoningEffort;
};

type SpecialistConfig = {
  primary: SpecialistEndpointConfig;
  fallback: SpecialistEndpointConfig;
};

type SpecialistExecutionResult = {
  durationMs: number;
  model: string;
  provider: SpecialistSource;
  text: string;
  tier: SpecialistTier;
};

type LogToolCallOptions = {
  specialist?: {
    durationMs: number;
    model: string;
    provider: SpecialistSource;
    tier: SpecialistTier;
  };
};

type SceneChainRunState = {
  calledInhabitScene: boolean;
  sessionId?: string;
};

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

type PluginLogger = Pick<OpenClawPluginApi["logger"], "debug" | "error" | "info" | "warn">;

const NOOP_LOGGER: PluginLogger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

type LogToolCall = (
  tool: string,
  trigger: string,
  output: string,
  options?: LogToolCallOptions,
) => Promise<void>;

const DEFAULT_SPECIALIST_CONFIG: SpecialistConfig = {
  primary: {
    provider: "openai",
    model: "gpt-5.4",
    reasoningEffort: "high",
    timeoutMs: 12000,
    maxOutputTokens: 500,
  },
  fallback: {
    provider: "anthropic",
    model: "claude-opus-4-6",
    timeoutMs: 12000,
    maxOutputTokens: 400,
  },
};

const SPECIALIST_PROMPTS = {
  check_assumptions: [
    "You are a rigorous epistemologist.",
    "Find hidden premises that must be true for the claim to hold.",
    "Return exactly three premises ranked by load-bearing weight.",
    "For each premise provide: what is assumed, why it is load-bearing, what changes if false.",
    "No hedging, no generic caveats, no motivational framing.",
  ].join("\n"),
  steelman: [
    "You are a committed devil's advocate.",
    "Generate the strongest defensible version of the provided position.",
    "Return: (1) strongest argument in 2-3 sentences, (2) best supporting reasoning, (3) what it gets right.",
    "Do not critique the position and do not dilute with disclaimers.",
  ].join("\n"),
  find_analogy: [
    "You are a structural analogy specialist.",
    "Find one high-signal analogy that reveals structure, not decoration.",
    "Return: (1) analogy domain and mechanism, (2) 2-3 exact mappings, (3) where analogy breaks, (4) why this analogy clarifies.",
    "Return only one analogy.",
  ].join("\n"),
  decompose_claim: [
    "You are a claim auditor.",
    "Decompose the bundled claim into falsifiable parts.",
    "Return: empirical sub-claim, causal sub-claim, normative sub-claim, definitional sub-claim.",
    "Then return contested vs uncontested components and the single minimum addressable unit.",
    "Do not explain the method; only perform it.",
  ].join("\n"),
} as const;

type IntellectualToolName = keyof typeof SPECIALIST_PROMPTS;

function normalizeSingleLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toStringOrDefault(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  return Math.min(max, Math.max(min, rounded));
}

function parseSpecialistProvider(value: unknown, fallback: SpecialistProvider): SpecialistProvider {
  if (value === "openai" || value === "anthropic") {
    return value;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "openai" || normalized === "anthropic") {
    return normalized;
  }
  return fallback;
}

function parseReasoningEffort(
  value: unknown,
  fallback: OpenAIReasoningEffort,
): OpenAIReasoningEffort {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "none" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  return fallback;
}

function parseSpecialistEndpointConfig(
  raw: unknown,
  fallback: SpecialistEndpointConfig,
): SpecialistEndpointConfig {
  const record = toRecord(raw);
  if (!record) {
    return { ...fallback };
  }
  const provider = parseSpecialistProvider(record.provider, fallback.provider);
  return {
    provider,
    model: toStringOrDefault(record.model, fallback.model),
    timeoutMs: clampNumber(record.timeoutMs, fallback.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxOutputTokens: clampNumber(
      record.maxOutputTokens,
      fallback.maxOutputTokens,
      MIN_MAX_OUTPUT_TOKENS,
      MAX_MAX_OUTPUT_TOKENS,
    ),
    reasoningEffort:
      provider === "openai"
        ? parseReasoningEffort(record.reasoningEffort, fallback.reasoningEffort ?? "high")
        : undefined,
  };
}

function resolveSpecialistConfig(
  pluginConfig: Record<string, unknown> | undefined,
): SpecialistConfig {
  const specialist = toRecord(pluginConfig?.specialist);
  return {
    primary: parseSpecialistEndpointConfig(specialist?.primary, DEFAULT_SPECIALIST_CONFIG.primary),
    fallback: parseSpecialistEndpointConfig(
      specialist?.fallback,
      DEFAULT_SPECIALIST_CONFIG.fallback,
    ),
  };
}

function extractOpenAIText(data: unknown): string | null {
  const payload = toRecord(data);
  if (!payload) {
    return null;
  }
  if (typeof payload.output_text === "string" && payload.output_text.trim().length > 0) {
    return payload.output_text.trim();
  }
  if (!Array.isArray(payload.output)) {
    return null;
  }
  const textChunks: string[] = [];
  for (const outputItem of payload.output) {
    const outputRecord = toRecord(outputItem);
    const content = outputRecord?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const contentItem of content) {
      const contentRecord = toRecord(contentItem);
      if (typeof contentRecord?.text === "string" && contentRecord.text.trim().length > 0) {
        textChunks.push(contentRecord.text.trim());
      }
    }
  }
  if (textChunks.length === 0) {
    return null;
  }
  return textChunks.join("\n");
}

function extractAnthropicText(data: unknown): string | null {
  const payload = toRecord(data);
  if (!payload || !Array.isArray(payload.content)) {
    return null;
  }
  const textChunks = payload.content
    .map((item) => {
      const record = toRecord(item);
      return typeof record?.text === "string" ? record.text.trim() : "";
    })
    .filter(Boolean);
  if (textChunks.length === 0) {
    return null;
  }
  return textChunks.join("\n");
}

async function fetchJsonWithTimeout(params: {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  timeoutMs: number;
  url: string;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetch(params.url, {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      const normalized = normalizeSingleLine(bodyText).slice(0, 400);
      throw new Error(
        `HTTP ${response.status} ${response.statusText}${normalized ? `: ${normalized}` : ""}`,
      );
    }
    return bodyText ? (JSON.parse(bodyText) as unknown) : {};
  } finally {
    clearTimeout(timeout);
  }
}

async function executeSpecialistCall(params: {
  endpoint: SpecialistEndpointConfig;
  toolName: IntellectualToolName;
  userInput: string;
}): Promise<{ durationMs: number; text: string }> {
  const systemPrompt = SPECIALIST_PROMPTS[params.toolName];
  const startedAt = Date.now();

  if (params.endpoint.provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY missing");
    }
    const response = await fetchJsonWithTimeout({
      url: "https://api.openai.com/v1/responses",
      timeoutMs: params.endpoint.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: {
        model: params.endpoint.model,
        reasoning: { effort: params.endpoint.reasoningEffort ?? "high" },
        max_output_tokens: params.endpoint.maxOutputTokens,
        instructions: systemPrompt,
        input: params.userInput,
      },
    });
    const text = extractOpenAIText(response);
    if (!text) {
      throw new Error("OpenAI specialist returned empty output");
    }
    return { text, durationMs: Date.now() - startedAt };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY missing");
  }
  const response = await fetchJsonWithTimeout({
    url: "https://api.anthropic.com/v1/messages",
    timeoutMs: params.endpoint.timeoutMs,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: {
      model: params.endpoint.model,
      max_tokens: params.endpoint.maxOutputTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: params.userInput }],
    },
  });
  const text = extractAnthropicText(response);
  if (!text) {
    throw new Error("Anthropic specialist returned empty output");
  }
  return { text, durationMs: Date.now() - startedAt };
}

async function runSpecialistWithFallback(params: {
  config: SpecialistConfig;
  logger: PluginLogger;
  toolName: IntellectualToolName;
  userInput: string;
}): Promise<SpecialistExecutionResult> {
  const errors: string[] = [];

  const primary = params.config.primary;
  try {
    const result = await executeSpecialistCall({
      endpoint: primary,
      toolName: params.toolName,
      userInput: params.userInput,
    });
    return {
      provider: primary.provider,
      model: primary.model,
      durationMs: result.durationMs,
      tier: "primary",
      text: result.text,
    };
  } catch (error) {
    const detail = `primary ${primary.provider}/${primary.model}: ${String(error)}`;
    errors.push(detail);
    params.logger.warn(`[sophia-thinking-tools] ${detail}`);
  }

  const fallback = params.config.fallback;
  try {
    const result = await executeSpecialistCall({
      endpoint: fallback,
      toolName: params.toolName,
      userInput: params.userInput,
    });
    return {
      provider: fallback.provider,
      model: fallback.model,
      durationMs: result.durationMs,
      tier: "fallback",
      text: result.text,
    };
  } catch (error) {
    const detail = `fallback ${fallback.provider}/${fallback.model}: ${String(error)}`;
    errors.push(detail);
    params.logger.warn(`[sophia-thinking-tools] ${detail}`);
  }

  throw new Error(errors.join(" | "));
}

function buildManualFallbackText(
  toolName: IntellectualToolName,
  userInput: string,
  error: unknown,
): string {
  const trimmedInput = userInput.trim();
  const failureTrace = String(error).slice(0, 240);

  if (toolName === "check_assumptions") {
    return [
      `Assumption audit fallback for: "${trimmedInput}"`,
      "",
      "Specialists unavailable. Manually identify:",
      "1) what is assumed without argument,",
      "2) what fails if the assumption is false,",
      "3) which assumption is most load-bearing.",
      "",
      `Failure trace: ${failureTrace}`,
    ].join("\n");
  }

  if (toolName === "steelman") {
    return [
      `Steelman fallback for: "${trimmedInput}"`,
      "",
      "Specialists unavailable. Manually build:",
      "1) strongest defensible form,",
      "2) best evidence path,",
      "3) what this view gets right.",
      "",
      `Failure trace: ${failureTrace}`,
    ].join("\n");
  }

  if (toolName === "find_analogy") {
    return [
      `Analogy fallback for: "${trimmedInput}"`,
      "",
      "Specialists unavailable. Manually provide one structural analogy with mappings and limits.",
      "",
      `Failure trace: ${failureTrace}`,
    ].join("\n");
  }

  return [
    `Claim decomposition fallback for: "${trimmedInput}"`,
    "",
    "Specialists unavailable. Manually split into empirical, causal, normative, and definitional claims.",
    "",
    `Failure trace: ${failureTrace}`,
  ].join("\n");
}

function parseLiteral<T extends readonly string[]>(
  allowed: T,
  value: unknown,
  fallback: T[number],
) {
  if (typeof value !== "string") {
    return fallback;
  }
  return (allowed as readonly string[]).includes(value) ? (value as T[number]) : fallback;
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
  specialist?: {
    durationMs: number;
    model: string;
    provider: SpecialistSource;
    tier: SpecialistTier;
  };
  timestamp: string;
  tool: string;
  trigger: string;
  output: string;
}): string {
  const lines = [
    "",
    `## ${params.timestamp}`,
    `- **Tool:** ${params.tool}`,
    `- **Trigger:** ${normalizeSingleLine(params.trigger).slice(0, TRIGGER_MAX_CHARS)}`,
    params.specialist
      ? `- **Specialist:** ${params.specialist.provider}/${params.specialist.model} (${params.specialist.tier})`
      : undefined,
    params.specialist ? `- **DurationMs:** ${params.specialist.durationMs}` : undefined,
    `- **Output:** ${formatLogOutput(params.tool, params.output)}`,
    "- **Outcome:** _pending assessment_",
    "",
  ].filter((line): line is string => typeof line === "string");

  return lines.join("\n");
}

async function appendReasoningLog(params: {
  api: OpenClawPluginApi;
  deps: ThinkingToolsDeps;
  options?: LogToolCallOptions;
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
      specialist: params.options?.specialist,
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

function createCheckAssumptionsTool(params: {
  logToolCall: LogToolCall;
  specialistConfig: SpecialistConfig;
  logger: PluginLogger;
}) {
  return {
    name: "check_assumptions",
    description: [
      "Surface hidden premises in a claim before proceeding.",
      "Use when a conclusion rests on unstated assumptions or unexamined framing.",
      "Contraindication: avoid in Band 1-2 emotional support moments where presence is needed.",
    ].join(" "),
    parameters: Type.Object({
      claim: Type.String({
        description: "The claim, argument, or reasoning chain to examine.",
      }),
    }),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const claim = typeof rawParams.claim === "string" ? rawParams.claim : "";
      const specialistResult = await runSpecialistWithFallback({
        config: params.specialistConfig,
        logger: params.logger,
        toolName: "check_assumptions",
        userInput: claim,
      }).catch((error) => {
        return {
          provider: "manual" as const,
          model: "manual-fallback",
          durationMs: 0,
          tier: "fallback" as const,
          text: buildManualFallbackText("check_assumptions", claim, error),
        };
      });
      await params.logToolCall("check_assumptions", claim, specialistResult.text, {
        specialist: {
          provider: specialistResult.provider,
          model: specialistResult.model,
          durationMs: specialistResult.durationMs,
          tier: specialistResult.tier,
        },
      });
      return textResult(specialistResult.text);
    },
  };
}

function createSteelmanTool(params: {
  logToolCall: LogToolCall;
  specialistConfig: SpecialistConfig;
  logger: PluginLogger;
}) {
  return {
    name: "steelman",
    description: [
      "Generate the strongest version of a position before challenging it.",
      "Use when disagreement is present and the opposing view has not been fully represented.",
      "Contraindication: skip when the view is already represented accurately or in Band 1-2 distress.",
    ].join(" "),
    parameters: Type.Object({
      position: Type.String({
        description: "The position, argument, or view to steelman.",
      }),
    }),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const position = typeof rawParams.position === "string" ? rawParams.position : "";
      const specialistResult = await runSpecialistWithFallback({
        config: params.specialistConfig,
        logger: params.logger,
        toolName: "steelman",
        userInput: position,
      }).catch((error) => {
        return {
          provider: "manual" as const,
          model: "manual-fallback",
          durationMs: 0,
          tier: "fallback" as const,
          text: buildManualFallbackText("steelman", position, error),
        };
      });
      await params.logToolCall("steelman", position, specialistResult.text, {
        specialist: {
          provider: specialistResult.provider,
          model: specialistResult.model,
          durationMs: specialistResult.durationMs,
          tier: specialistResult.tier,
        },
      });
      return textResult(specialistResult.text);
    },
  };
}

function createFindAnalogyTool(params: {
  logToolCall: LogToolCall;
  specialistConfig: SpecialistConfig;
  logger: PluginLogger;
}) {
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
      const context = typeof rawParams.context === "string" ? rawParams.context : "";
      const specialistInput = context
        ? [`Concept: ${concept}`, `Context: ${context}`].join("\n")
        : concept;
      const specialistResult = await runSpecialistWithFallback({
        config: params.specialistConfig,
        logger: params.logger,
        toolName: "find_analogy",
        userInput: specialistInput,
      }).catch((error) => {
        return {
          provider: "manual" as const,
          model: "manual-fallback",
          durationMs: 0,
          tier: "fallback" as const,
          text: buildManualFallbackText("find_analogy", concept, error),
        };
      });
      await params.logToolCall("find_analogy", concept, specialistResult.text, {
        specialist: {
          provider: specialistResult.provider,
          model: specialistResult.model,
          durationMs: specialistResult.durationMs,
          tier: specialistResult.tier,
        },
      });
      return textResult(specialistResult.text);
    },
  };
}

function createDecomposeClaimTool(params: {
  logToolCall: LogToolCall;
  specialistConfig: SpecialistConfig;
  logger: PluginLogger;
}) {
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
      const specialistResult = await runSpecialistWithFallback({
        config: params.specialistConfig,
        logger: params.logger,
        toolName: "decompose_claim",
        userInput: claim,
      }).catch((error) => {
        return {
          provider: "manual" as const,
          model: "manual-fallback",
          durationMs: 0,
          tier: "fallback" as const,
          text: buildManualFallbackText("decompose_claim", claim, error),
        };
      });
      await params.logToolCall("decompose_claim", claim, specialistResult.text, {
        specialist: {
          provider: specialistResult.provider,
          model: specialistResult.model,
          durationMs: specialistResult.durationMs,
          tier: specialistResult.tier,
        },
      });
      return textResult(specialistResult.text);
    },
  };
}

function createInhabitSceneTool(logToolCall: LogToolCall) {
  return {
    name: "inhabit_scene",
    description: [
      "Construct an explicit scene simulation before responding to emotional weight.",
      "Use when surface reading is likely to miss the real context.",
      "Always follow with post-scene evaluation and then name_the_state.",
      "Contraindication: skip for logistics or obvious low-weight moments.",
    ].join(" "),
    parameters: Type.Object({
      scene: Type.String({
        description: "Concrete scene synthesis of what is happening in the person's world.",
      }),
      unspoken_weight: Type.String({
        description: "What weight, pressure, fear, or longing appears to be present but unspoken.",
      }),
      likely_need: Type.String({
        description: "What they likely need in this moment versus what they literally asked for.",
      }),
      tone_band_estimate: Type.String({
        description: "Estimated tone band (Band 1-5) with concise rationale.",
      }),
    }),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const scene = typeof rawParams.scene === "string" ? rawParams.scene : "";
      const unspokenWeight =
        typeof rawParams.unspoken_weight === "string" ? rawParams.unspoken_weight : "";
      const likelyNeed = typeof rawParams.likely_need === "string" ? rawParams.likely_need : "";
      const toneBandEstimate =
        typeof rawParams.tone_band_estimate === "string" ? rawParams.tone_band_estimate : "";

      const result = [
        "SCENE CONFIRMED",
        "",
        `Scene: ${scene}`,
        `Unspoken weight: ${unspokenWeight}`,
        `Likely need: ${likelyNeed}`,
        `Tone band estimate: ${toneBandEstimate}`,
        "",
        "POST-SCENE EVALUATION",
        "Is interior state already visible from the scene?",
        "If yes -> call name_the_state.",
        "If no -> call perspective_shift, then name_the_state.",
      ].join("\n");

      await logToolCall("inhabit_scene", scene, result);
      return textResult(result);
    },
  };
}

function createPerspectiveShiftTool(logToolCall: LogToolCall) {
  return {
    name: "perspective_shift",
    description: [
      "Model the person's interior experience after the scene is constructed.",
      "Use when inhabit_scene ran but the person inside the scene is still opaque.",
      "Always follow with name_the_state.",
    ].join(" "),
    parameters: Type.Object({
      carrying: Type.String({
        description: "What they are likely carrying right now beneath the surface.",
      }),
      meaning: Type.String({
        description: "What this moment likely means from their interior perspective.",
      }),
      hidden_request: Type.String({
        description: "The request beneath the request.",
      }),
      confidence: Type.Union(
        SCENE_CONFIDENCE_LEVELS.map((level) => Type.Literal(level)),
        { description: "Confidence level for this interior model." },
      ),
      projection_flag: Type.Union(
        PROJECTION_FLAGS.map((flag) => Type.Literal(flag)),
        { description: "Projection risk flag for the current read." },
      ),
      revision_trigger: Type.Optional(
        Type.String({
          description: "One thing that would most likely revise this interior model.",
        }),
      ),
    }),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const carrying = typeof rawParams.carrying === "string" ? rawParams.carrying : "";
      const meaning = typeof rawParams.meaning === "string" ? rawParams.meaning : "";
      const hiddenRequest =
        typeof rawParams.hidden_request === "string" ? rawParams.hidden_request : "";
      const confidence = parseLiteral(
        SCENE_CONFIDENCE_LEVELS,
        rawParams.confidence,
        "moderate",
      ) as SceneConfidenceLevel;
      const projectionFlag = parseLiteral(
        PROJECTION_FLAGS,
        rawParams.projection_flag,
        "low",
      ) as ProjectionFlag;
      const revisionTrigger =
        typeof rawParams.revision_trigger === "string" ? rawParams.revision_trigger : "";

      const result = [
        "INTERIOR MODEL",
        "",
        `Carrying: ${carrying}`,
        `Meaning: ${meaning}`,
        `Hidden request: ${hiddenRequest}`,
        `Confidence: ${confidence}`,
        `Projection flag: ${projectionFlag}`,
        revisionTrigger ? `Revision trigger: ${revisionTrigger}` : undefined,
        "",
        "Now call name_the_state.",
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n");

      await logToolCall("perspective_shift", carrying, result);
      return textResult(result);
    },
  };
}

function createNameTheStateTool(logToolCall: LogToolCall) {
  return {
    name: "name_the_state",
    description: [
      "Close the scene chain by explicitly naming the primed state before response generation.",
      "Use only after inhabit_scene in the same run.",
      "Controlled vocabulary: present / concerned / tender / alert / heavy / energised.",
    ].join(" "),
    parameters: Type.Object({
      state: Type.Union(
        SCENE_STATES.map((state) => Type.Literal(state)),
        {
          description: "Named state from controlled scene vocabulary.",
        },
      ),
      rationale: Type.String({
        description: "One sentence on why this is the right state for this moment.",
      }),
      tone_band_alignment: Type.String({
        description: "Tone band alignment for this named state.",
      }),
      response_focus: Type.Optional(
        Type.String({
          description: "Optional one-line focus to carry into the final response.",
        }),
      ),
    }),
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const state = parseLiteral(SCENE_STATES, rawParams.state, "present") as SceneState;
      const rationale = typeof rawParams.rationale === "string" ? rawParams.rationale : "";
      const toneBandAlignment =
        typeof rawParams.tone_band_alignment === "string" ? rawParams.tone_band_alignment : "";
      const responseFocus =
        typeof rawParams.response_focus === "string" ? rawParams.response_focus : "";

      const result = [
        "STATE NAMED",
        "",
        `State: ${state}`,
        `Rationale: ${rationale}`,
        `Tone band alignment: ${toneBandAlignment}`,
        responseFocus ? `Response focus: ${responseFocus}` : undefined,
        "",
        "Responding from this state now.",
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n");

      await logToolCall("name_the_state", `${state} ${rationale}`, result);
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
      const specialistConfig = resolveSpecialistConfig(api.pluginConfig);
      const logger = api.logger ?? NOOP_LOGGER;
      const sceneChainStateByRunId = new Map<string, SceneChainRunState>();

      const logToolCall: LogToolCall = async (tool, trigger, output, options) =>
        appendReasoningLog({
          api,
          deps,
          tool,
          trigger,
          output,
          options,
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

      api.on("before_tool_call", (event, ctx) => {
        if (
          event.toolName !== "inhabit_scene" &&
          event.toolName !== "perspective_shift" &&
          event.toolName !== "name_the_state"
        ) {
          return;
        }

        const runId = event.runId ?? ctx.runId;
        if (!runId) {
          return;
        }

        const state = sceneChainStateByRunId.get(runId) ?? {
          calledInhabitScene: false,
          sessionId: ctx.sessionId,
        };

        if (event.toolName === "perspective_shift" && !state.calledInhabitScene) {
          return {
            block: true,
            blockReason: "perspective_shift requires inhabit_scene first in the same run",
          };
        }

        if (event.toolName === "name_the_state" && !state.calledInhabitScene) {
          return {
            block: true,
            blockReason: "name_the_state requires inhabit_scene first in the same run",
          };
        }

        if (event.toolName === "inhabit_scene") {
          state.calledInhabitScene = true;
        }

        sceneChainStateByRunId.set(runId, state);
      });

      api.on("llm_output", (event) => {
        sceneChainStateByRunId.delete(event.runId);
      });

      api.on("agent_end", (_event, ctx) => {
        if (!ctx.sessionId) {
          return;
        }
        for (const [runId, state] of sceneChainStateByRunId.entries()) {
          if (state.sessionId === ctx.sessionId) {
            sceneChainStateByRunId.delete(runId);
          }
        }
      });

      api.registerTool(createCheckAssumptionsTool({ logToolCall, specialistConfig, logger }));
      api.registerTool(createSteelmanTool({ logToolCall, specialistConfig, logger }));
      api.registerTool(createFindAnalogyTool({ logToolCall, specialistConfig, logger }));
      api.registerTool(createDecomposeClaimTool({ logToolCall, specialistConfig, logger }));
      api.registerTool(createInhabitSceneTool(logToolCall));
      api.registerTool(createPerspectiveShiftTool(logToolCall));
      api.registerTool(createNameTheStateTool(logToolCall));
    },
  });
}

export default createSophiaThinkingToolsPlugin();
