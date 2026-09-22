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
 *
 * P12 `01` §7 (G8/DF-16): relocated verbatim from `@arbor/application` to
 * `ports` so adapters no longer need an `application` edge. The recipe and
 * the resulting digest are byte-for-byte unchanged (no governance item).
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
