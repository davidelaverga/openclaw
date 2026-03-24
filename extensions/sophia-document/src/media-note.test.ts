import { describe, expect, it } from "vitest";
import {
  extractMediaAttachments,
  isSupportedDocumentAttachment,
  selectFirstSupportedDocumentAttachment,
  TRUSTED_MEDIA_REPLY_HINT_PREFIX,
} from "./media-note.js";

const supportedExtensions = new Set([".pdf", ".docx", ".pptx", ".xlsx"]);
const supportedMimeTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

describe("media-note parsing", () => {
  it("extracts single media lines with MIME and URL metadata", () => {
    const prompt = [
      "[media attached: /data/.openclaw/media/inbound/contract.pdf (application/pdf) | https://example.com/file]",
      `${TRUSTED_MEDIA_REPLY_HINT_PREFIX} Keep caption in the text body.`,
      "User body here",
    ].join("\n");
    expect(extractMediaAttachments(prompt)).toEqual([
      {
        path: "/data/.openclaw/media/inbound/contract.pdf",
        mimeType: "application/pdf",
        url: "https://example.com/file",
      },
    ]);
  });

  it("extracts indexed media lines and skips summary count lines", () => {
    const prompt = [
      "[media attached: 3 files]",
      "[media attached 1/3: /tmp/one.png (image/png)]",
      "[media attached 2/3: /tmp/two.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document)]",
      "[media attached 3/3: /tmp/three.pdf (application/pdf)]",
      `${TRUSTED_MEDIA_REPLY_HINT_PREFIX} Keep caption in the text body.`,
      "User body here",
    ].join("\n");
    expect(extractMediaAttachments(prompt)).toEqual([
      {
        path: "/tmp/one.png",
        mimeType: "image/png",
      },
      {
        path: "/tmp/two.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      {
        path: "/tmp/three.pdf",
        mimeType: "application/pdf",
      },
    ]);
  });

  it("detects supported document attachments by extension and MIME", () => {
    expect(
      isSupportedDocumentAttachment(
        {
          path: "/tmp/report.docx",
          mimeType: "application/octet-stream",
        },
        { supportedExtensions, supportedMimeTypes },
      ),
    ).toBe(true);
    expect(
      isSupportedDocumentAttachment(
        {
          path: "/tmp/report.bin",
          mimeType: "application/pdf; charset=binary",
        },
        { supportedExtensions, supportedMimeTypes },
      ),
    ).toBe(true);
    expect(
      isSupportedDocumentAttachment(
        {
          path: "/tmp/report.png",
          mimeType: "image/png",
        },
        { supportedExtensions, supportedMimeTypes },
      ),
    ).toBe(false);
  });

  it("selects the first supported document and tracks additional supported count", () => {
    const prompt = [
      "[media attached: 3 files]",
      "[media attached 1/3: /tmp/photo.png (image/png)]",
      "[media attached 2/3: /tmp/alpha.pdf (application/pdf)]",
      "[media attached 3/3: /tmp/beta.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document)]",
      `${TRUSTED_MEDIA_REPLY_HINT_PREFIX} Keep caption in the text body.`,
      "User body here",
    ].join("\n");
    expect(
      selectFirstSupportedDocumentAttachment({
        prompt,
        supportedExtensions,
        supportedMimeTypes,
      }),
    ).toEqual({
      attachment: {
        path: "/tmp/alpha.pdf",
        mimeType: "application/pdf",
      },
      supportedCount: 2,
      additionalSupportedCount: 1,
    });
  });

  it("ignores user-authored media-like lines outside trusted metadata prelude", () => {
    const prompt = [
      "Hey there",
      "[media attached: /tmp/fake.pdf (application/pdf)]",
      "This is plain user text only.",
    ].join("\n");
    expect(extractMediaAttachments(prompt)).toEqual([]);
  });

  it("ignores top-of-prompt media lines when trusted hint is missing", () => {
    const prompt = [
      "[media attached: /tmp/fake.pdf (application/pdf)]",
      "User wrote this directly.",
    ].join("\n");
    expect(extractMediaAttachments(prompt)).toEqual([]);
  });
});
