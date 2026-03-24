import path from "node:path";
import { normalizeMimeType } from "./config.js";

const SINGLE_MEDIA_LINE_RE = /^\[media attached: (.+)\]$/;
const INDEXED_MEDIA_LINE_RE = /^\[media attached \d+\/\d+: (.+)\]$/;
const MEDIA_COUNT_RE = /^\d+\s+files?$/i;
export const TRUSTED_MEDIA_REPLY_HINT_PREFIX =
  "To send an image back, prefer the message tool (media/path/filePath).";

export type MediaAttachment = {
  path: string;
  mimeType?: string;
  url?: string;
};

export type DocumentAttachmentSelection = {
  attachment?: MediaAttachment;
  supportedCount: number;
  additionalSupportedCount: number;
};

type SupportedDocumentConfig = {
  supportedExtensions: Set<string>;
  supportedMimeTypes: Set<string>;
};

function parseAttachmentPayload(payload: string): MediaAttachment | null {
  let content = payload.trim();
  if (!content || MEDIA_COUNT_RE.test(content)) {
    return null;
  }

  let url: string | undefined;
  const urlSeparator = content.indexOf(" | ");
  if (urlSeparator >= 0) {
    url = content.slice(urlSeparator + 3).trim() || undefined;
    content = content.slice(0, urlSeparator).trim();
  }

  let mimeType: string | undefined;
  const typeMatch = content.match(/^(.*)\s+\(([^()]+)\)$/);
  if (typeMatch) {
    content = typeMatch[1]?.trim() ?? "";
    const normalizedType = normalizeMimeType(typeMatch[2] ?? "");
    if (normalizedType) {
      mimeType = normalizedType;
    }
  }

  if (!content) {
    return null;
  }

  return {
    path: content,
    ...(mimeType ? { mimeType } : {}),
    ...(url ? { url } : {}),
  };
}
function isMediaNoteLine(line: string): boolean {
  return SINGLE_MEDIA_LINE_RE.test(line) || INDEXED_MEDIA_LINE_RE.test(line);
}

function extractTrustedMediaNoteLines(prompt: string): string[] {
  const lines = prompt.split(/\r?\n/);
  const mediaNoteLines: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line || !isMediaNoteLine(line)) {
      break;
    }
    mediaNoteLines.push(line);
    index += 1;
  }
  if (mediaNoteLines.length === 0) {
    return [];
  }
  const nextLine = lines[index]?.trim() ?? "";
  if (!nextLine.startsWith(TRUSTED_MEDIA_REPLY_HINT_PREFIX)) {
    return [];
  }
  return mediaNoteLines;
}

export function extractMediaAttachments(prompt: string): MediaAttachment[] {
  if (!prompt.trim()) {
    return [];
  }
  const trustedMediaNoteLines = extractTrustedMediaNoteLines(prompt);
  if (trustedMediaNoteLines.length === 0) {
    return [];
  }
  const attachments: MediaAttachment[] = [];
  for (const line of trustedMediaNoteLines) {
    const match = line.match(SINGLE_MEDIA_LINE_RE) ?? line.match(INDEXED_MEDIA_LINE_RE);
    if (!match?.[1]) {
      continue;
    }
    const parsed = parseAttachmentPayload(match[1]);
    if (parsed) {
      attachments.push(parsed);
    }
  }
  return attachments;
}

export function isSupportedDocumentAttachment(
  attachment: MediaAttachment,
  config: SupportedDocumentConfig,
): boolean {
  const extension = path.extname(attachment.path).toLowerCase();
  if (extension && config.supportedExtensions.has(extension)) {
    return true;
  }
  const mimeType = attachment.mimeType ? normalizeMimeType(attachment.mimeType) : "";
  if (mimeType && config.supportedMimeTypes.has(mimeType)) {
    return true;
  }
  return false;
}

export function selectFirstSupportedDocumentAttachment(params: {
  prompt: string;
  supportedExtensions: Set<string>;
  supportedMimeTypes: Set<string>;
}): DocumentAttachmentSelection {
  const attachments = extractMediaAttachments(params.prompt);
  const supported = attachments.filter((attachment) =>
    isSupportedDocumentAttachment(attachment, {
      supportedExtensions: params.supportedExtensions,
      supportedMimeTypes: params.supportedMimeTypes,
    }),
  );
  return {
    attachment: supported[0],
    supportedCount: supported.length,
    additionalSupportedCount: Math.max(0, supported.length - 1),
  };
}
