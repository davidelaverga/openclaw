import fs from "node:fs/promises";
import path from "node:path";

export type InboundDocumentPathResolution =
  | {
      ok: true;
      resolvedPath: string;
      fileName: string;
    }
  | {
      ok: false;
      reason: string;
    };

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveInboundDocumentPath(params: {
  candidatePath: string;
  inboundRoot: string;
}): Promise<InboundDocumentPathResolution> {
  const trimmedCandidate = params.candidatePath.trim();
  if (!trimmedCandidate) {
    return { ok: false, reason: "empty_candidate_path" };
  }

  const candidateAbsolute = path.isAbsolute(trimmedCandidate)
    ? path.resolve(trimmedCandidate)
    : path.resolve(params.inboundRoot, trimmedCandidate);

  let inboundRootRealPath: string;
  try {
    inboundRootRealPath = await fs.realpath(params.inboundRoot);
  } catch {
    return { ok: false, reason: "inbound_root_not_found" };
  }

  let candidateRealPath: string;
  try {
    candidateRealPath = await fs.realpath(candidateAbsolute);
  } catch {
    return { ok: false, reason: "candidate_not_found" };
  }

  if (!isPathInside(inboundRootRealPath, candidateRealPath)) {
    return { ok: false, reason: "candidate_outside_inbound_root" };
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(candidateRealPath);
  } catch {
    return { ok: false, reason: "candidate_stat_failed" };
  }

  if (!stat.isFile()) {
    return { ok: false, reason: "candidate_not_file" };
  }

  return {
    ok: true,
    resolvedPath: candidateRealPath,
    fileName: path.basename(candidateRealPath),
  };
}
