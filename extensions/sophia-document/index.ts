import { readFile } from "node:fs/promises";
import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolveSophiaDocumentConfig } from "./src/config.js";
import { buildDocumentFailureSystemContext, buildDocumentSystemContext } from "./src/context.js";
import { resolveInboundDocumentPath } from "./src/inbound-path.js";
import { parseDocumentWithLlamaParse } from "./src/llamaparse.js";
import { selectFirstSupportedDocumentAttachment } from "./src/media-note.js";

type SophiaDocumentPluginDeps = {
  readFileFn: typeof readFile;
  fetchFn: typeof fetch;
  resolveStateDirFn: typeof resolveStateDir;
  nowFn: () => number;
};

const defaultDeps: SophiaDocumentPluginDeps = {
  readFileFn: readFile,
  fetchFn: fetch,
  resolveStateDirFn: resolveStateDir,
  nowFn: Date.now,
};

function stringifyError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

async function runBeforePromptBuild(params: {
  api: OpenClawPluginApi;
  deps: SophiaDocumentPluginDeps;
  event: { prompt: string; messages: unknown[] };
}): Promise<{ appendSystemContext: string } | undefined> {
  const config = resolveSophiaDocumentConfig(params.api.pluginConfig);
  const selection = selectFirstSupportedDocumentAttachment({
    prompt: params.event.prompt,
    supportedExtensions: config.supportedExtensions,
    supportedMimeTypes: config.supportedMimeTypes,
  });
  const attachment = selection.attachment;
  if (!attachment) {
    return undefined;
  }

  const inboundRoot = path.join(params.deps.resolveStateDirFn(), "media", "inbound");
  const resolvedDocumentPath = await resolveInboundDocumentPath({
    candidatePath: attachment.path,
    inboundRoot,
  });
  const attachmentFileName = path.basename(attachment.path.trim()) || "document";

  if (!resolvedDocumentPath.ok) {
    params.api.logger.warn(
      `[sophia-document] attachment path validation failed (${resolvedDocumentPath.reason})`,
    );
    return {
      appendSystemContext: buildDocumentFailureSystemContext({
        fileName: attachmentFileName,
        reason: "Attached file path could not be validated under inbound media storage.",
        additionalSupportedDocuments: selection.additionalSupportedCount,
      }),
    };
  }

  const apiKey = process.env.LLAMA_CLOUD_API_KEY?.trim();
  if (!apiKey) {
    params.api.logger.warn("[sophia-document] LLAMA_CLOUD_API_KEY missing; skipping parse");
    return {
      appendSystemContext: buildDocumentFailureSystemContext({
        fileName: resolvedDocumentPath.fileName,
        reason: "LLAMA_CLOUD_API_KEY is not configured.",
        additionalSupportedDocuments: selection.additionalSupportedCount,
      }),
    };
  }

  let fileBytes: Buffer;
  try {
    fileBytes = await params.deps.readFileFn(resolvedDocumentPath.resolvedPath);
  } catch (error) {
    const message = stringifyError(error);
    params.api.logger.warn(`[sophia-document] failed reading inbound document: ${message}`);
    return {
      appendSystemContext: buildDocumentFailureSystemContext({
        fileName: resolvedDocumentPath.fileName,
        reason: "Inbound document file could not be read.",
        additionalSupportedDocuments: selection.additionalSupportedCount,
      }),
    };
  }

  try {
    const parseResult = await parseDocumentWithLlamaParse({
      apiKey,
      baseUrl: config.baseUrl,
      tier: config.tier,
      version: config.version,
      pollIntervalMs: config.pollIntervalMs,
      pollTimeoutMs: config.pollTimeoutMs,
      fileName: resolvedDocumentPath.fileName,
      fileBytes,
      mimeType: attachment.mimeType,
      fetchFn: params.deps.fetchFn,
      now: params.deps.nowFn,
    });
    if (!parseResult.markdown.trim()) {
      return {
        appendSystemContext: buildDocumentFailureSystemContext({
          fileName: resolvedDocumentPath.fileName,
          reason: "LlamaParse returned no markdown content.",
          additionalSupportedDocuments: selection.additionalSupportedCount,
        }),
      };
    }
    return {
      appendSystemContext: buildDocumentSystemContext({
        fileName: resolvedDocumentPath.fileName,
        mimeType: attachment.mimeType,
        tier: config.tier,
        markdown: parseResult.markdown,
        maxChars: config.maxChars,
        additionalSupportedDocuments: selection.additionalSupportedCount,
      }),
    };
  } catch (error) {
    const message = stringifyError(error);
    params.api.logger.warn(`[sophia-document] parse failed: ${message}`);
    return {
      appendSystemContext: buildDocumentFailureSystemContext({
        fileName: resolvedDocumentPath.fileName,
        reason: `LlamaParse request failed: ${message}`,
        additionalSupportedDocuments: selection.additionalSupportedCount,
      }),
    };
  }
}

export function createSophiaDocumentPlugin(overrides: Partial<SophiaDocumentPluginDeps> = {}) {
  const deps: SophiaDocumentPluginDeps = {
    ...defaultDeps,
    ...overrides,
  };
  return definePluginEntry({
    id: "sophia-document",
    name: "Sophia Document",
    description:
      "Parses inbound document attachments with LlamaParse and appends bounded markdown context.",
    register(api) {
      api.on("before_prompt_build", async (event) =>
        runBeforePromptBuild({
          api,
          deps,
          event,
        }),
      );
    },
  });
}

export default createSophiaDocumentPlugin();
