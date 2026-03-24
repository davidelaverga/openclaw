import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-runtime";

export function buildDocumentSystemContext(params: {
  fileName: string;
  mimeType?: string;
  tier: string;
  markdown: string;
  maxChars: number;
  additionalSupportedDocuments: number;
}): string {
  const normalizedMarkdown = params.markdown.trim();
  const boundedMarkdown = truncateUtf16Safe(normalizedMarkdown, params.maxChars);
  const truncated = boundedMarkdown.length < normalizedMarkdown.length;

  const lines = [
    "[Document shared by user]",
    `Filename: ${params.fileName}${params.mimeType ? ` | MIME: ${params.mimeType}` : ""} | Parsed with LlamaParse (${params.tier})`,
    params.additionalSupportedDocuments > 0
      ? `Additional supported documents not parsed this turn: ${params.additionalSupportedDocuments}.`
      : undefined,
    truncated
      ? `Document content was truncated to ${params.maxChars} characters before injection.`
      : undefined,
    "",
    "--- Document content ---",
    boundedMarkdown,
    "--- End of document ---",
    "",
    "Read this document before responding. Keep your normal tone and persona.",
  ];
  return lines.filter(Boolean).join("\n");
}

export function buildDocumentFailureSystemContext(params: {
  fileName: string;
  reason: string;
  additionalSupportedDocuments: number;
}): string {
  const lines = [
    "[Document parsing unavailable]",
    `Filename: ${params.fileName}`,
    `Reason: ${params.reason}`,
    params.additionalSupportedDocuments > 0
      ? `Additional supported documents not parsed this turn: ${params.additionalSupportedDocuments}.`
      : undefined,
    "",
    "A supported document was attached, but parsing failed for this turn.",
  ];
  return lines.filter(Boolean).join("\n");
}
