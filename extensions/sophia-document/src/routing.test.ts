import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALWAYS_PARSE_DOCUMENT_EXTENSIONS,
  DEFAULT_ALWAYS_PARSE_DOCUMENT_MIME_TYPES,
  DEFAULT_FALLBACK_PARSE_DOCUMENT_EXTENSIONS,
  DEFAULT_FALLBACK_PARSE_DOCUMENT_MIME_TYPES,
} from "./config.js";
import { selectDocumentParseRoute } from "./routing.js";

function makeConfig(
  overrides: {
    alwaysParseExtensions?: Set<string>;
    fallbackParseExtensions?: Set<string>;
    alwaysParseMimeTypes?: Set<string>;
    fallbackParseMimeTypes?: Set<string>;
    forceLlamaParsePdf?: boolean;
  } = {},
) {
  return {
    alwaysParseExtensions:
      overrides.alwaysParseExtensions ?? new Set(DEFAULT_ALWAYS_PARSE_DOCUMENT_EXTENSIONS),
    fallbackParseExtensions:
      overrides.fallbackParseExtensions ?? new Set(DEFAULT_FALLBACK_PARSE_DOCUMENT_EXTENSIONS),
    alwaysParseMimeTypes:
      overrides.alwaysParseMimeTypes ?? new Set(DEFAULT_ALWAYS_PARSE_DOCUMENT_MIME_TYPES),
    fallbackParseMimeTypes:
      overrides.fallbackParseMimeTypes ?? new Set(DEFAULT_FALLBACK_PARSE_DOCUMENT_MIME_TYPES),
    forceLlamaParsePdf: overrides.forceLlamaParsePdf ?? false,
  };
}

describe("document parse routing", () => {
  it("lets native handling win for usable trusted PDF file blocks", () => {
    const decision = selectDocumentParseRoute({
      fileName: "paper.pdf",
      mimeType: "application/pdf",
      trustedPromptFileBlocks: [
        {
          fileName: "paper.pdf",
          mimeType: "application/pdf",
          state: "usable",
        },
      ],
      config: makeConfig(),
    });

    expect(decision).toMatchObject({
      route: "native",
      reason: "trusted_file_block_usable",
      extension: ".pdf",
      fileBlockState: "usable",
      routePolicyMatchSource: "extension",
    });
  });

  it("falls back to LlamaParse for degraded trusted PDF file blocks", () => {
    const decision = selectDocumentParseRoute({
      fileName: "paper.pdf",
      mimeType: "application/pdf",
      trustedPromptFileBlocks: [
        {
          fileName: "paper.pdf",
          mimeType: "application/pdf",
          state: "degraded",
        },
      ],
      config: makeConfig(),
    });

    expect(decision).toMatchObject({
      route: "llamaparse",
      reason: "trusted_file_block_degraded",
      extension: ".pdf",
      fileBlockState: "degraded",
      routePolicyMatchSource: "extension",
    });
  });

  it("routes extensionless spreadsheets by MIME policy", () => {
    const decision = selectDocumentParseRoute({
      fileName: "upload",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      trustedPromptFileBlocks: [
        {
          fileName: "upload",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          state: "usable",
        },
      ],
      config: makeConfig(),
    });

    expect(decision).toMatchObject({
      route: "llamaparse",
      reason: "always_parse_route_policy",
      extension: "",
      routePolicyMatchSource: "mime",
      fileBlockState: "usable",
    });
  });

  it("lets extensionless PDFs stay native when trusted extraction is usable", () => {
    const decision = selectDocumentParseRoute({
      fileName: "download",
      mimeType: "application/pdf",
      trustedPromptFileBlocks: [
        {
          fileName: "download",
          mimeType: "application/pdf",
          state: "usable",
        },
      ],
      config: makeConfig(),
    });

    expect(decision).toMatchObject({
      route: "native",
      reason: "trusted_file_block_usable",
      extension: "",
      fileBlockState: "usable",
      routePolicyMatchSource: "mime",
    });
  });

  it("falls back to LlamaParse for extensionless PDFs when trusted extraction is missing", () => {
    const decision = selectDocumentParseRoute({
      fileName: "download",
      mimeType: "application/pdf",
      trustedPromptFileBlocks: [],
      config: makeConfig(),
    });

    expect(decision).toMatchObject({
      route: "llamaparse",
      reason: "trusted_file_block_missing",
      extension: "",
      routePolicyMatchSource: "mime",
      fileBlockState: "missing",
    });
  });

  it("supports forcing MIME-only PDFs through LlamaParse", () => {
    const decision = selectDocumentParseRoute({
      fileName: "upload",
      mimeType: "application/pdf",
      trustedPromptFileBlocks: [
        {
          fileName: "upload",
          mimeType: "application/pdf",
          state: "usable",
        },
      ],
      config: makeConfig({ forceLlamaParsePdf: true }),
    });

    expect(decision).toMatchObject({
      route: "llamaparse",
      reason: "force_llamaparse_pdf",
      extension: "",
      routePolicyMatchSource: "mime",
      fileBlockState: "usable",
    });
  });
});
