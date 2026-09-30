import type {
  CommandId,
  CommandReceipt,
  CommandResolution,
  ProjectId,
  SemanticRequestFingerprint,
} from "@arbor/domain";
import { FINGERPRINT_ALGORITHM_VERSION } from "./fingerprint.js";
import type { CommandRejection } from "./rejection.js";

export const decodeCommandReceipt = <R>(
  stored: CommandReceipt<unknown, unknown>,
): CommandReceipt<R, CommandRejection> => ({
  ...stored,
  resolution:
    stored.resolution._tag === "Committed"
      ? { _tag: "Committed", result: stored.resolution.result as R }
      : {
          _tag: "TerminalRejected",
          error: stored.resolution.error as CommandRejection,
        },
});

export const makeCommandReceipt = <R>(
  commandId: CommandId,
  projectId: ProjectId,
  fingerprint: SemanticRequestFingerprint,
  schemaVersion: string,
  resolution: CommandResolution<R, CommandRejection>,
  createdAt: string,
  settledAt: string,
): CommandReceipt<R, CommandRejection> => ({
  commandId,
  projectId,
  semanticRequestFingerprint: fingerprint,
  schemaVersion,
  fingerprintAlgorithmVersion: FINGERPRINT_ALGORITHM_VERSION,
  resolution,
  createdAt,
  settledAt,
});
