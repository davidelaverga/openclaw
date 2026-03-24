import path from "node:path";
import type { SophiaDocumentConfig } from "./config.js";
import {
  classifyPromptFileBlock,
  findPromptFileBlock,
  type PromptFileBlock,
  type PromptFileBlockState,
} from "./prompt-file-block.js";

export type DocumentParseRouteDecision = {
  route: "native" | "llamaparse";
  reason: string;
  extension: string;
  fileBlockState: PromptFileBlockState;
  matchedFileBlock?: PromptFileBlock;
};

export function selectDocumentParseRoute(params: {
  prompt: string;
  fileName: string;
  config: Pick<
    SophiaDocumentConfig,
    "alwaysParseExtensions" | "fallbackParseExtensions" | "forceLlamaParsePdf"
  >;
}): DocumentParseRouteDecision {
  const extension = path.extname(params.fileName).toLowerCase();
  const matchedFileBlock = findPromptFileBlock(params.prompt, params.fileName);
  const fileBlockState = classifyPromptFileBlock(matchedFileBlock);

  if (params.config.forceLlamaParsePdf && extension === ".pdf") {
    return {
      route: "llamaparse",
      reason: "force_llamaparse_pdf",
      extension,
      fileBlockState,
      ...(matchedFileBlock ? { matchedFileBlock } : {}),
    };
  }

  if (extension && params.config.alwaysParseExtensions.has(extension)) {
    return {
      route: "llamaparse",
      reason: "always_parse_extension",
      extension,
      fileBlockState,
      ...(matchedFileBlock ? { matchedFileBlock } : {}),
    };
  }

  if (extension && params.config.fallbackParseExtensions.has(extension)) {
    if (fileBlockState === "missing") {
      return {
        route: "llamaparse",
        reason: "matching_file_block_missing",
        extension,
        fileBlockState,
      };
    }
    if (fileBlockState === "degraded") {
      return {
        route: "llamaparse",
        reason: "matching_file_block_degraded",
        extension,
        fileBlockState,
        ...(matchedFileBlock ? { matchedFileBlock } : {}),
      };
    }
    return {
      route: "native",
      reason: "matching_file_block_usable",
      extension,
      fileBlockState,
      ...(matchedFileBlock ? { matchedFileBlock } : {}),
    };
  }

  return {
    route: "native",
    reason: "extension_not_routed",
    extension,
    fileBlockState,
    ...(matchedFileBlock ? { matchedFileBlock } : {}),
  };
}
