import type {
  CommandId,
  CommandReceipt,
  CommandResolution,
  ProjectId,
  SemanticRequestFingerprint,
} from "@arbor/domain";
import type { StoredCommandResolution } from "@arbor/ports";
import { FINGERPRINT_ALGORITHM_VERSION } from "./fingerprint.js";
import type { CommandRejection } from "./rejection.js";

export const decodeCommandReceipt = <R>(
  stored: StoredCommandResolution,
): CommandReceipt<R, CommandRejection> => ({
  commandId: stored.commandId,
  projectId: stored.projectId,
  semanticRequestFingerprint: stored.semanticRequestFingerprint,
  schemaVersion: stored.schemaVersion,
  fingerprintAlgorithmVersion: stored.fingerprintAlgorithmVersion,
  createdAt: stored.createdAt,
  settledAt: stored.settledAt,
  resolution:
    stored.resolution === "Committed"
      ? {
          _tag: "Committed",
          result: JSON.parse(stored.resultJson ?? "null") as R,
        }
      : {
          _tag: "TerminalRejected",
          error: JSON.parse(
            stored.terminalErrorJson ?? "null",
          ) as CommandRejection,
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
