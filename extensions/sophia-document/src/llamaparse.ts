import { sleep } from "openclaw/plugin-sdk/text-runtime";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type NowFn = () => number;

type ParseJobStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export type ParseDocumentWithLlamaParseParams = {
  apiKey: string;
  baseUrl: string;
  tier: string;
  version: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  fileName: string;
  fileBytes: Buffer;
  mimeType?: string;
  fetchFn?: FetchFn;
  now?: NowFn;
};

export type ParseDocumentWithLlamaParseResult = {
  jobId: string;
  markdown: string;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toStatus(value: unknown): ParseJobStatus | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (
    normalized === "PENDING" ||
    normalized === "RUNNING" ||
    normalized === "COMPLETED" ||
    normalized === "FAILED" ||
    normalized === "CANCELLED"
  ) {
    return normalized;
  }
  return undefined;
}

function getJobEnvelope(payload: unknown): {
  id?: string;
  status?: ParseJobStatus;
  errorMessage?: string;
} {
  const root = toRecord(payload) ?? {};
  const job = toRecord(root.job) ?? root;
  return {
    ...(typeof job.id === "string" ? { id: job.id } : {}),
    ...(toStatus(job.status) ? { status: toStatus(job.status) } : {}),
    ...(typeof job.error_message === "string"
      ? { errorMessage: job.error_message }
      : typeof job.error === "string"
        ? { errorMessage: job.error }
        : {}),
  };
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  return await response.json().catch(() => null);
}

async function parseErrorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.trim().slice(0, 400);
}

export function buildLlamaParseUploadFormData(params: {
  fileName: string;
  fileBytes: Buffer;
  tier: string;
  version: string;
  mimeType?: string;
}): FormData {
  const form = new FormData();
  form.append(
    "file",
    new Blob([params.fileBytes], {
      type: params.mimeType ?? "application/octet-stream",
    }),
    params.fileName,
  );
  form.append(
    "configuration",
    JSON.stringify({
      tier: params.tier,
      version: params.version,
      output_options: {
        markdown: {},
      },
    }),
  );
  return form;
}

function normalizeMarkdownPages(pages: unknown[]): string {
  const chunks: string[] = [];
  for (const page of pages) {
    const pageRecord = toRecord(page);
    if (!pageRecord) {
      continue;
    }
    if (typeof pageRecord.markdown === "string" && pageRecord.markdown.trim()) {
      chunks.push(pageRecord.markdown.trim());
      continue;
    }
    if (typeof pageRecord.text === "string" && pageRecord.text.trim()) {
      chunks.push(pageRecord.text.trim());
    }
  }
  return chunks.join("\n\n").trim();
}

function normalizeMarkdownCandidate(candidate: unknown): string {
  if (typeof candidate === "string") {
    return candidate.trim();
  }
  if (Array.isArray(candidate)) {
    return normalizeMarkdownPages(candidate);
  }
  const record = toRecord(candidate);
  if (!record) {
    return "";
  }
  if (typeof record.markdown === "string" && record.markdown.trim()) {
    return record.markdown.trim();
  }
  if (Array.isArray(record.pages)) {
    return normalizeMarkdownPages(record.pages);
  }
  return "";
}

export function extractMarkdownFromParseResponse(payload: unknown): string {
  const root = toRecord(payload) ?? {};
  const nestedResult = toRecord(root.result) ?? {};
  const nestedOutput = toRecord(root.output) ?? {};
  const candidates = [
    root.markdown,
    nestedResult.markdown,
    nestedOutput.markdown,
    root.text,
    nestedResult.text,
  ];
  for (const candidate of candidates) {
    const markdown = normalizeMarkdownCandidate(candidate);
    if (markdown) {
      return markdown;
    }
  }
  return "";
}

async function pollParseResult(params: {
  apiKey: string;
  baseUrl: string;
  jobId: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  fetchFn: FetchFn;
  now: NowFn;
}): Promise<unknown> {
  const deadline = params.now() + params.pollTimeoutMs;
  while (true) {
    const response = await params.fetchFn(
      `${params.baseUrl}/api/v2/parse/${encodeURIComponent(params.jobId)}?expand=markdown`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
        },
      },
    );
    if (!response.ok) {
      const body = await parseErrorText(response);
      throw new Error(
        `LlamaParse poll failed (${response.status} ${response.statusText})${body ? `: ${body}` : ""}`,
      );
    }
    const payload = await parseJsonResponse(response);
    const job = getJobEnvelope(payload);
    const markdown = extractMarkdownFromParseResponse(payload);
    if (job.status === "COMPLETED" || (!job.status && markdown)) {
      return payload;
    }
    if (job.status === "FAILED" || job.status === "CANCELLED") {
      throw new Error(job.errorMessage?.trim() || `parse job ended with status ${job.status}`);
    }
    if (params.now() >= deadline) {
      throw new Error("parse polling timed out");
    }
    await sleep(Math.max(0, params.pollIntervalMs));
  }
}

export async function parseDocumentWithLlamaParse(
  params: ParseDocumentWithLlamaParseParams,
): Promise<ParseDocumentWithLlamaParseResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const now = params.now ?? Date.now;
  const uploadResponse = await fetchFn(`${params.baseUrl}/api/v2/parse/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: buildLlamaParseUploadFormData({
      fileBytes: params.fileBytes,
      fileName: params.fileName,
      tier: params.tier,
      version: params.version,
      mimeType: params.mimeType,
    }),
  });
  if (!uploadResponse.ok) {
    const body = await parseErrorText(uploadResponse);
    throw new Error(
      `LlamaParse upload failed (${uploadResponse.status} ${uploadResponse.statusText})${body ? `: ${body}` : ""}`,
    );
  }
  const uploadPayload = await parseJsonResponse(uploadResponse);
  const uploadJob = getJobEnvelope(uploadPayload);
  if (!uploadJob.id) {
    throw new Error("LlamaParse upload response missing job id");
  }

  const pollPayload = await pollParseResult({
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    jobId: uploadJob.id,
    pollIntervalMs: params.pollIntervalMs,
    pollTimeoutMs: params.pollTimeoutMs,
    fetchFn,
    now,
  });
  const markdown = extractMarkdownFromParseResponse(pollPayload);
  return {
    jobId: uploadJob.id,
    markdown,
  };
}
