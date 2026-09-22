import { createHash } from "node:crypto";
import {
  EnvironmentFingerprint,
  fingerprintInputBytes,
  type SnapshotRegionEntry,
} from "@arbor/domain";

/**
 * P11 `02` §1: the digest step of snapshot identity. The canonical recipe
 * (which bytes) is owned by the domain (`fingerprintInputBytes`); this is
 * the pure sha256 over those bytes. Same input bytes -> same fingerprint,
 * always.
 */
export const fingerprintOf = (
  projectId: string,
  regions: ReadonlyArray<SnapshotRegionEntry>,
): EnvironmentFingerprint =>
  EnvironmentFingerprint.of(
    createHash("sha256")
      .update(fingerprintInputBytes(projectId, regions))
      .digest("hex"),
  );

export const digestOfBytes = (bytes: string): string =>
  createHash("sha256").update(bytes).digest("hex");
