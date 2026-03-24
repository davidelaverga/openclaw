export const DEFAULT_LLAMA_BASE_URL = "https://api.cloud.llamaindex.ai";
export const DEFAULT_LLAMA_TIER = "cost_effective";
export const DEFAULT_LLAMA_VERSION = "latest";
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_POLL_TIMEOUT_MS = 45_000;
export const DEFAULT_MAX_CHARS = 48_000;
export const DEFAULT_FORCE_LLAMA_PARSE_PDF = false;

const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 10_000;
const MIN_POLL_TIMEOUT_MS = 5_000;
const MAX_POLL_TIMEOUT_MS = 180_000;
const MIN_MAX_CHARS = 2_000;
const MAX_MAX_CHARS = 200_000;

export const DEFAULT_ALWAYS_PARSE_DOCUMENT_EXTENSIONS = new Set([".ppt", ".pptx", ".xls", ".xlsx"]);
export const DEFAULT_FALLBACK_PARSE_DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx"]);
export const DEFAULT_SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  ...DEFAULT_ALWAYS_PARSE_DOCUMENT_EXTENSIONS,
  ...DEFAULT_FALLBACK_PARSE_DOCUMENT_EXTENSIONS,
]);

export const DEFAULT_SUPPORTED_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export type SophiaDocumentConfig = {
  baseUrl: string;
  tier: string;
  version: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  maxChars: number;
  forceLlamaParsePdf: boolean;
  alwaysParseExtensions: Set<string>;
  fallbackParseExtensions: Set<string>;
  supportedExtensions: Set<string>;
  supportedMimeTypes: Set<string>;
};

type RawSophiaDocumentConfig = {
  baseUrl?: unknown;
  tier?: unknown;
  version?: unknown;
  pollIntervalMs?: unknown;
  pollTimeoutMs?: unknown;
  maxChars?: unknown;
  forceLlamaParsePdf?: unknown;
  alwaysParseExtensions?: unknown;
  fallbackParseExtensions?: unknown;
  supportedExtensions?: unknown;
  supportedMimeTypes?: unknown;
};

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function normalizeMimeType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

function normalizeExtension(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function normalizeStringSet(
  raw: unknown,
  normalizer: (value: string) => string,
  fallback: Set<string>,
): Set<string> {
  if (!Array.isArray(raw)) {
    return new Set(fallback);
  }
  const values = raw
    .map((entry) => (typeof entry === "string" ? normalizer(entry) : ""))
    .filter(Boolean);
  return values.length > 0 ? new Set(values) : new Set(fallback);
}

function normalizeBaseUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return DEFAULT_LLAMA_BASE_URL;
  }
  return raw.replace(/\/+$/, "");
}

function normalizeTier(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw || DEFAULT_LLAMA_TIER;
}

function normalizeVersion(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw || DEFAULT_LLAMA_VERSION;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function resolveSophiaDocumentConfig(raw: unknown): SophiaDocumentConfig {
  const config = toRecord(raw) as RawSophiaDocumentConfig;
  const pollIntervalMs = clampInteger(
    config.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
  );
  const pollTimeoutMs = Math.max(
    pollIntervalMs,
    clampInteger(
      config.pollTimeoutMs,
      DEFAULT_POLL_TIMEOUT_MS,
      MIN_POLL_TIMEOUT_MS,
      MAX_POLL_TIMEOUT_MS,
    ),
  );
  const forceLlamaParsePdf = config.forceLlamaParsePdf === true;
  const alwaysParseExtensions = normalizeStringSet(
    config.alwaysParseExtensions,
    normalizeExtension,
    DEFAULT_ALWAYS_PARSE_DOCUMENT_EXTENSIONS,
  );
  const fallbackParseExtensions = normalizeStringSet(
    config.fallbackParseExtensions,
    normalizeExtension,
    DEFAULT_FALLBACK_PARSE_DOCUMENT_EXTENSIONS,
  );
  if (forceLlamaParsePdf) {
    alwaysParseExtensions.add(".pdf");
    fallbackParseExtensions.delete(".pdf");
  }
  const defaultSupportedExtensions = new Set([
    ...alwaysParseExtensions,
    ...fallbackParseExtensions,
  ]);
  return {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    tier: normalizeTier(config.tier),
    version: normalizeVersion(config.version),
    pollIntervalMs,
    pollTimeoutMs,
    maxChars: clampInteger(config.maxChars, DEFAULT_MAX_CHARS, MIN_MAX_CHARS, MAX_MAX_CHARS),
    forceLlamaParsePdf,
    alwaysParseExtensions,
    fallbackParseExtensions,
    supportedExtensions: normalizeStringSet(
      config.supportedExtensions,
      normalizeExtension,
      defaultSupportedExtensions,
    ),
    supportedMimeTypes: normalizeStringSet(
      config.supportedMimeTypes,
      normalizeMimeType,
      DEFAULT_SUPPORTED_DOCUMENT_MIME_TYPES,
    ),
  };
}
