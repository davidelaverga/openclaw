import path from "node:path";
import { normalizeMimeType, type SophiaDocumentConfig } from "./config.js";

const PDF_MIME_TYPE = "application/pdf";

export type TrustedDocumentPromptFileBlock = {
  fileName: string;
  mimeType?: string;
  state: "degraded" | "usable";
};

export type PromptFileBlockState = "missing" | "degraded" | "usable";
export type RoutePolicyMatchSource = "extension" | "mime" | "none";

export type DocumentParseRouteDecision = {
  route: "native" | "llamaparse";
  reason: string;
  extension: string;
  mimeType: string;
  routePolicyMatchSource: RoutePolicyMatchSource;
  fileBlockState: PromptFileBlockState;
  matchedTrustedFileBlock?: TrustedDocumentPromptFileBlock;
};

function findTrustedPromptFileBlock(
  trustedPromptFileBlocks: TrustedDocumentPromptFileBlock[] | undefined,
  fileName: string,
): TrustedDocumentPromptFileBlock | undefined {
  const normalizedFileName = fileName.trim();
  if (!normalizedFileName || !trustedPromptFileBlocks || trustedPromptFileBlocks.length === 0) {
    return undefined;
  }
  return trustedPromptFileBlocks.find((block) => block.fileName.trim() === normalizedFileName);
}

function classifyTrustedPromptFileBlock(
  block?: TrustedDocumentPromptFileBlock,
): PromptFileBlockState {
  if (!block) {
    return "missing";
  }
  return block.state;
}

function resolveRoutePolicyMatch(params: {
  extension: string;
  mimeType: string;
  config: Pick<
    SophiaDocumentConfig,
    | "alwaysParseExtensions"
    | "fallbackParseExtensions"
    | "alwaysParseMimeTypes"
    | "fallbackParseMimeTypes"
  >;
}): { routeFamily: "always" | "fallback" | "none"; source: RoutePolicyMatchSource } {
  if (params.extension && params.config.alwaysParseExtensions.has(params.extension)) {
    return { routeFamily: "always", source: "extension" };
  }
  if (params.extension && params.config.fallbackParseExtensions.has(params.extension)) {
    return { routeFamily: "fallback", source: "extension" };
  }
  if (params.mimeType && params.config.alwaysParseMimeTypes.has(params.mimeType)) {
    return { routeFamily: "always", source: "mime" };
  }
  if (params.mimeType && params.config.fallbackParseMimeTypes.has(params.mimeType)) {
    return { routeFamily: "fallback", source: "mime" };
  }
  return { routeFamily: "none", source: "none" };
}

export function selectDocumentParseRoute(params: {
  fileName: string;
  mimeType?: string;
  trustedPromptFileBlocks?: TrustedDocumentPromptFileBlock[];
  config: Pick<
    SophiaDocumentConfig,
    | "alwaysParseExtensions"
    | "fallbackParseExtensions"
    | "alwaysParseMimeTypes"
    | "fallbackParseMimeTypes"
    | "forceLlamaParsePdf"
  >;
}): DocumentParseRouteDecision {
  const extension = path.extname(params.fileName).toLowerCase();
  const matchedTrustedFileBlock = findTrustedPromptFileBlock(
    params.trustedPromptFileBlocks,
    params.fileName,
  );
  const fileBlockState = classifyTrustedPromptFileBlock(matchedTrustedFileBlock);
  const mimeType = normalizeMimeType(params.mimeType ?? matchedTrustedFileBlock?.mimeType ?? "");
  const routePolicyMatch = resolveRoutePolicyMatch({
    extension,
    mimeType,
    config: params.config,
  });

  if (params.config.forceLlamaParsePdf && (extension === ".pdf" || mimeType === PDF_MIME_TYPE)) {
    return {
      route: "llamaparse",
      reason: "force_llamaparse_pdf",
      extension,
      mimeType,
      routePolicyMatchSource: extension === ".pdf" ? "extension" : "mime",
      fileBlockState,
      ...(matchedTrustedFileBlock ? { matchedTrustedFileBlock } : {}),
    };
  }

  if (routePolicyMatch.routeFamily === "always") {
    return {
      route: "llamaparse",
      reason: "always_parse_route_policy",
      extension,
      mimeType,
      routePolicyMatchSource: routePolicyMatch.source,
      fileBlockState,
      ...(matchedTrustedFileBlock ? { matchedTrustedFileBlock } : {}),
    };
  }

  if (routePolicyMatch.routeFamily === "fallback") {
    if (fileBlockState === "missing") {
      return {
        route: "llamaparse",
        reason: "trusted_file_block_missing",
        extension,
        mimeType,
        routePolicyMatchSource: routePolicyMatch.source,
        fileBlockState,
      };
    }
    if (fileBlockState === "degraded") {
      return {
        route: "llamaparse",
        reason: "trusted_file_block_degraded",
        extension,
        mimeType,
        routePolicyMatchSource: routePolicyMatch.source,
        fileBlockState,
        ...(matchedTrustedFileBlock ? { matchedTrustedFileBlock } : {}),
      };
    }
    return {
      route: "native",
      reason: "trusted_file_block_usable",
      extension,
      mimeType,
      routePolicyMatchSource: routePolicyMatch.source,
      fileBlockState,
      ...(matchedTrustedFileBlock ? { matchedTrustedFileBlock } : {}),
    };
  }

  return {
    route: "native",
    reason: "extension_or_mime_not_routed",
    extension,
    mimeType,
    routePolicyMatchSource: routePolicyMatch.source,
    fileBlockState,
    ...(matchedTrustedFileBlock ? { matchedTrustedFileBlock } : {}),
  };
}
