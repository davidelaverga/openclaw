import { readFile } from "node:fs/promises";
import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolveSophiaDocumentConfig } from "./src/config.js";
import { buildDocumentFailureSystemContext, buildDocumentSystemContext } from "./src/context.js";
import { resolveInboundDocumentPath } from "./src/inbound-path.js";
import { parseDocumentWithLlamaParse } from "./src/llamaparse.js";
import {
  extractMediaAttachments,
  selectFirstSupportedDocumentAttachment,
} from "./src/media-note.js";
import { selectDocumentParseRoute } from "./src/routing.js";

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

function logPluginEvent(params: {
  api: OpenClawPluginApi;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  details?: Record<string, unknown>;
}): void {
  const message = `[sophia-document] ${JSON.stringify({
    event: params.event,
    pluginId: "sophia-document",
    ...(params.details ?? {}),
  })}`;
  switch (params.level) {
    case "debug":
      params.api.logger.debug(message);
      return;
    case "info":
      params.api.logger.info(message);
      return;
    case "warn":
      params.api.logger.warn(message);
      return;
    case "error":
      params.api.logger.error(message);
      return;
  }
}

async function runBeforePromptBuild(params: {
  api: OpenClawPluginApi;
  deps: SophiaDocumentPluginDeps;
  event: {
    prompt: string;
    messages: unknown[];
    trustedPromptFileBlocks?: Array<{
      fileName: string;
      mimeType?: string;
      state: "degraded" | "usable";
    }>;
  };
}): Promise<{ appendSystemContext: string } | undefined> {
  const config = resolveSophiaDocumentConfig(params.api.pluginConfig);
  const attachments = extractMediaAttachments(params.event.prompt);
  const selection = selectFirstSupportedDocumentAttachment({
    prompt: params.event.prompt,
    supportedExtensions: config.supportedExtensions,
    supportedMimeTypes: config.supportedMimeTypes,
  });
  const attachment = selection.attachment;
  if (!attachment) {
    if (attachments.length > 0) {
      logPluginEvent({
        api: params.api,
        level: "info",
        event: "route",
        details: {
          route: "skip_unsupported",
          attachmentCount: attachments.length,
          supportedCount: selection.supportedCount,
        },
      });
    }
    return undefined;
  }
  const attachmentFileName = path.basename(attachment.path.trim()) || "document";
  logPluginEvent({
    api: params.api,
    level: "info",
    event: "attachment_detected",
    details: {
      fileName: attachmentFileName,
      mimeType: attachment.mimeType ?? null,
      attachmentCount: attachments.length,
      supportedCount: selection.supportedCount,
      additionalSupportedDocuments: selection.additionalSupportedCount,
    },
  });
  const routeDecision = selectDocumentParseRoute({
    fileName: attachmentFileName,
    mimeType: attachment.mimeType,
    trustedPromptFileBlocks: params.event.trustedPromptFileBlocks,
    config,
  });
  logPluginEvent({
    api: params.api,
    level: "info",
    event: "matching_file_block",
    details: {
      fileName: attachmentFileName,
      state: routeDecision.fileBlockState,
      trustBoundary: routeDecision.matchedTrustedFileBlock ? "trusted" : "missing",
      mimeType: routeDecision.matchedTrustedFileBlock?.mimeType ?? null,
    },
  });
  logPluginEvent({
    api: params.api,
    level: "info",
    event: "route",
    details: {
      route: routeDecision.route,
      reason: routeDecision.reason,
      fileName: attachmentFileName,
      extension: routeDecision.extension || null,
      mimeType: routeDecision.mimeType || null,
      routePolicyMatchSource: routeDecision.routePolicyMatchSource,
      supportedCount: selection.supportedCount,
      additionalSupportedDocuments: selection.additionalSupportedCount,
      fileBlockState: routeDecision.fileBlockState,
    },
  });
  if (routeDecision.route === "native") {
    return undefined;
  }

  const inboundRoot = path.join(params.deps.resolveStateDirFn(), "media", "inbound");
  const resolvedDocumentPath = await resolveInboundDocumentPath({
    candidatePath: attachment.path,
    inboundRoot,
  });

  if (!resolvedDocumentPath.ok) {
    logPluginEvent({
      api: params.api,
      level: "warn",
      event: "attachment_path_validation_failed",
      details: {
        fileName: attachmentFileName,
        reason: resolvedDocumentPath.reason,
      },
    });
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
    logPluginEvent({
      api: params.api,
      level: "warn",
      event: "parse_skipped_missing_api_key",
      details: {
        fileName: resolvedDocumentPath.fileName,
      },
    });
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
    logPluginEvent({
      api: params.api,
      level: "warn",
      event: "inbound_document_read_failed",
      details: {
        fileName: resolvedDocumentPath.fileName,
        error: message,
      },
    });
    return {
      appendSystemContext: buildDocumentFailureSystemContext({
        fileName: resolvedDocumentPath.fileName,
        reason: "Inbound document file could not be read.",
        additionalSupportedDocuments: selection.additionalSupportedCount,
      }),
    };
  }

  try {
    logPluginEvent({
      api: params.api,
      level: "info",
      event: "parse_start",
      details: {
        fileName: resolvedDocumentPath.fileName,
        extension: routeDecision.extension || null,
        reason: routeDecision.reason,
        tier: config.tier,
        bytes: fileBytes.byteLength,
      },
    });
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
      logPluginEvent({
        api: params.api,
        level: "warn",
        event: "parse_empty",
        details: {
          fileName: resolvedDocumentPath.fileName,
          jobId: parseResult.jobId,
        },
      });
      return {
        appendSystemContext: buildDocumentFailureSystemContext({
          fileName: resolvedDocumentPath.fileName,
          reason: "LlamaParse returned no markdown content.",
          additionalSupportedDocuments: selection.additionalSupportedCount,
        }),
      };
    }
    logPluginEvent({
      api: params.api,
      level: "info",
      event: "parse_success",
      details: {
        fileName: resolvedDocumentPath.fileName,
        jobId: parseResult.jobId,
        markdownChars: parseResult.markdown.length,
      },
    });
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
    logPluginEvent({
      api: params.api,
      level: "warn",
      event: message.includes("parse polling timed out") ? "parse_timeout" : "parse_failed",
      details: {
        fileName: resolvedDocumentPath.fileName,
        error: message,
      },
    });
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
      "Routes inbound document attachments between native prompt context and LlamaParse.",
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
