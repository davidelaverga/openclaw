export const DEGRADED_PROMPT_FILE_BLOCK_CONTENTS = new Set([
  "[No extractable text]",
  "[PDF content rendered to images; images not forwarded to model]",
]);

const FILE_BLOCK_RE = /<file\b([^>]*)>([\s\S]*?)<\/file>/gi;
const FILE_ATTR_RE = /(\w+)="([^"]*)"/g;

export type PromptFileBlock = {
  fileName: string;
  mimeType?: string;
  content: string;
};

export type PromptFileBlockState = "missing" | "degraded" | "usable";

function decodeXmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseFileBlockAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  FILE_ATTR_RE.lastIndex = 0;
  for (const match of raw.matchAll(FILE_ATTR_RE)) {
    const key = match[1]?.trim();
    const value = match[2];
    if (!key || value === undefined) {
      continue;
    }
    attrs[key] = decodeXmlAttr(value);
  }
  return attrs;
}

export function extractPromptFileBlocks(prompt: string): PromptFileBlock[] {
  if (!prompt.trim()) {
    return [];
  }
  const blocks: PromptFileBlock[] = [];
  FILE_BLOCK_RE.lastIndex = 0;
  for (const match of prompt.matchAll(FILE_BLOCK_RE)) {
    const attrs = parseFileBlockAttrs(match[1] ?? "");
    const fileName = attrs.name?.trim();
    if (!fileName) {
      continue;
    }
    const mimeType = attrs.mime?.trim();
    blocks.push({
      fileName,
      ...(mimeType ? { mimeType } : {}),
      content: match[2] ?? "",
    });
  }
  return blocks;
}

export function findPromptFileBlock(prompt: string, fileName: string): PromptFileBlock | undefined {
  const normalizedFileName = fileName.trim();
  if (!normalizedFileName) {
    return undefined;
  }
  return extractPromptFileBlocks(prompt).find((block) => block.fileName === normalizedFileName);
}

export function classifyPromptFileBlock(block?: PromptFileBlock): PromptFileBlockState {
  if (!block) {
    return "missing";
  }
  const content = block.content.trim();
  if (!content || DEGRADED_PROMPT_FILE_BLOCK_CONTENTS.has(content)) {
    return "degraded";
  }
  return "usable";
}
