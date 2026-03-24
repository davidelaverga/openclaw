import { describe, expect, it, vi } from "vitest";
import {
  buildLlamaParseUploadFormData,
  extractMarkdownFromParseResponse,
  parseDocumentWithLlamaParse,
} from "./llamaparse.js";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

describe("LlamaParse v2 client helpers", () => {
  it("uses multipart field configuration (not config)", () => {
    const form = buildLlamaParseUploadFormData({
      fileName: "contract.pdf",
      fileBytes: Buffer.from("pdf"),
      tier: "cost_effective",
      version: "latest",
      mimeType: "application/pdf",
    });

    const configurationRaw = form.get("configuration");
    expect(typeof configurationRaw).toBe("string");
    expect(form.get("config")).toBeNull();
    expect(JSON.parse(configurationRaw as string)).toMatchObject({
      tier: "cost_effective",
      version: "latest",
      output_options: {
        markdown: {},
      },
    });
  });

  it("normalizes markdown pages from expanded result payloads", () => {
    expect(
      extractMarkdownFromParseResponse({
        job: { status: "COMPLETED" },
        markdown: {
          pages: [
            { page: 1, markdown: "# One" },
            { page: 2, markdown: "Two" },
          ],
        },
      }),
    ).toBe("# One\n\nTwo");
  });

  it("polls using job.status until completion", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "job-1", status: "PENDING" }))
      .mockResolvedValueOnce(jsonResponse({ job: { id: "job-1", status: "RUNNING" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          job: { id: "job-1", status: "COMPLETED" },
          markdown: { pages: [{ page: 1, markdown: "hello world" }] },
        }),
      );

    const result = await parseDocumentWithLlamaParse({
      apiKey: "llx-test",
      baseUrl: "https://api.cloud.llamaindex.ai",
      tier: "cost_effective",
      version: "latest",
      pollIntervalMs: 0,
      pollTimeoutMs: 10_000,
      fileName: "doc.pdf",
      fileBytes: Buffer.from("pdf"),
      fetchFn,
      now: (() => {
        let value = 0;
        return () => {
          value += 1;
          return value;
        };
      })(),
    });

    expect(result).toEqual({
      jobId: "job-1",
      markdown: "hello world",
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(String(fetchFn.mock.calls[1]?.[0])).toContain("/api/v2/parse/job-1?expand=markdown");
  });

  it("surfaces job.error_message on failure statuses", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "job-2", status: "PENDING" }))
      .mockResolvedValueOnce(
        jsonResponse({
          job: {
            id: "job-2",
            status: "FAILED",
            error_message: "broken document",
          },
        }),
      );

    await expect(
      parseDocumentWithLlamaParse({
        apiKey: "llx-test",
        baseUrl: "https://api.cloud.llamaindex.ai",
        tier: "cost_effective",
        version: "latest",
        pollIntervalMs: 0,
        pollTimeoutMs: 10_000,
        fileName: "doc.pdf",
        fileBytes: Buffer.from("pdf"),
        fetchFn,
        now: Date.now,
      }),
    ).rejects.toThrow(/broken document/);
  });
});
