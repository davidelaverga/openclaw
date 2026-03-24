import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInboundDocumentPath } from "./inbound-path.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("resolveInboundDocumentPath", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("accepts files inside inbound root", async () => {
    const root = await makeTempDir("sophia-document-inbound-");
    const filePath = path.join(root, "doc.pdf");
    await fs.writeFile(filePath, "ok");
    const result = await resolveInboundDocumentPath({
      inboundRoot: root,
      candidatePath: filePath,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fileName).toBe("doc.pdf");
      expect(result.resolvedPath.endsWith(`${path.sep}doc.pdf`)).toBe(true);
    }
  });

  it("rejects files outside inbound root", async () => {
    const root = await makeTempDir("sophia-document-inbound-");
    const outsideDir = await makeTempDir("sophia-document-outside-");
    const outsideFilePath = path.join(outsideDir, "doc.pdf");
    await fs.writeFile(outsideFilePath, "nope");

    await expect(
      resolveInboundDocumentPath({
        inboundRoot: root,
        candidatePath: outsideFilePath,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "candidate_outside_inbound_root",
    });
  });

  it("rejects symlink escapes", async () => {
    const root = await makeTempDir("sophia-document-inbound-");
    const outsideDir = await makeTempDir("sophia-document-outside-");
    const outsideFilePath = path.join(outsideDir, "secret.pdf");
    await fs.writeFile(outsideFilePath, "secret");
    const symlinkPath = path.join(root, "link.pdf");
    await fs.symlink(outsideFilePath, symlinkPath);

    await expect(
      resolveInboundDocumentPath({
        inboundRoot: root,
        candidatePath: symlinkPath,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "candidate_outside_inbound_root",
    });
  });
});
