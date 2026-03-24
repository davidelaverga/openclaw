import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALWAYS_PARSE_DOCUMENT_EXTENSIONS,
  DEFAULT_FALLBACK_PARSE_DOCUMENT_EXTENSIONS,
} from "./config.js";
import { selectDocumentParseRoute } from "./routing.js";

function makeConfig(
  overrides: {
    alwaysParseExtensions?: Set<string>;
    fallbackParseExtensions?: Set<string>;
    forceLlamaParsePdf?: boolean;
  } = {},
) {
  return {
    alwaysParseExtensions:
      overrides.alwaysParseExtensions ?? new Set(DEFAULT_ALWAYS_PARSE_DOCUMENT_EXTENSIONS),
    fallbackParseExtensions:
      overrides.fallbackParseExtensions ?? new Set(DEFAULT_FALLBACK_PARSE_DOCUMENT_EXTENSIONS),
    forceLlamaParsePdf: overrides.forceLlamaParsePdf ?? false,
  };
}

describe("document parse routing", () => {
  it("lets native handling win for usable PDF file blocks", () => {
    const decision = selectDocumentParseRoute({
      prompt: `<file name="paper.pdf" mime="application/pdf">\nExtracted paper text\n</file>`,
      fileName: "paper.pdf",
      config: makeConfig(),
    });

    expect(decision).toMatchObject({
      route: "native",
      reason: "matching_file_block_usable",
      extension: ".pdf",
      fileBlockState: "usable",
    });
  });

  it("falls back to LlamaParse for degraded PDF file blocks", () => {
    const decision = selectDocumentParseRoute({
      prompt: '<file name="paper.pdf" mime="application/pdf">\n[No extractable text]\n</file>',
      fileName: "paper.pdf",
      config: makeConfig(),
    });

    expect(decision).toMatchObject({
      route: "llamaparse",
      reason: "matching_file_block_degraded",
      extension: ".pdf",
      fileBlockState: "degraded",
    });
  });

  it("always routes spreadsheets through LlamaParse", () => {
    const decision = selectDocumentParseRoute({
      prompt:
        '<file name="report.xlsx" mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">\nSheet preview text\n</file>',
      fileName: "report.xlsx",
      config: makeConfig(),
    });

    expect(decision).toMatchObject({
      route: "llamaparse",
      reason: "always_parse_extension",
      extension: ".xlsx",
      fileBlockState: "usable",
    });
  });

  it("supports forcing PDFs through LlamaParse", () => {
    const decision = selectDocumentParseRoute({
      prompt: `<file name="paper.pdf" mime="application/pdf">\nExtracted paper text\n</file>`,
      fileName: "paper.pdf",
      config: makeConfig({ forceLlamaParsePdf: true }),
    });

    expect(decision).toMatchObject({
      route: "llamaparse",
      reason: "force_llamaparse_pdf",
      extension: ".pdf",
      fileBlockState: "usable",
    });
  });
});
