import type {
  Actor,
  CommandId,
  WorkContractSnapshot,
  WorkId,
  WorkRevision,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { WorkRepositoryError } from "./errors.js";
import { sha256Hex } from "./provider-extension.js";
import type { TransactionScope } from "./session.js";

export type WorkContractRevisionKind =
  | "Initial"
  | "DirectionGuidance"
  | "ContractAmendment"
  | "LegacyCurrentSnapshot";

export interface WorkContractRevisionRecord {
  readonly workId: WorkId;
  readonly workRevision: WorkRevision;
  readonly contract: WorkContractSnapshot;
  readonly contractSha256: string;
  readonly kind: WorkContractRevisionKind;
  readonly sourceCommandId: CommandId | null;
  readonly actor: Actor | null;
  readonly provenance: unknown | null;
  readonly recordedAt: string;
}

export type AppendWorkContractRevision = Omit<
  WorkContractRevisionRecord,
  "contractSha256"
>;

export const canonicalWorkContractJson = (
  value: WorkContractSnapshot,
): string => {
  const canonical = (item: unknown): string => {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      return JSON.stringify(item);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new TypeError(
          "Work contract snapshot contains a non-finite number",
        );
      }
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (typeof item !== "object" || item === undefined) {
      throw new TypeError("Work contract snapshot is not canonical JSON");
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => {
        const member = record[key];
        if (member === undefined) {
          throw new TypeError("Work contract snapshot contains undefined");
        }
        return `${JSON.stringify(key)}:${canonical(member)}`;
      })
      .join(",")}}`;
  };
  return canonical(value);
};

export const workContractSnapshotDigest = (
  value: WorkContractSnapshot,
): string => sha256Hex(canonicalWorkContractJson(value));

export interface WorkContractRevisionRepositoryService {
  readonly append: (
    input: AppendWorkContractRevision,
  ) => Effect.Effect<void, WorkRepositoryError, TransactionScope>;
  readonly findByWorkRevision: (
    workId: WorkId,
    workRevision: WorkRevision,
  ) => Effect.Effect<
    Option.Option<WorkContractRevisionRecord>,
    WorkRepositoryError,
    TransactionScope
  >;
  readonly listByWork: (
    workId: WorkId,
  ) => Effect.Effect<
    ReadonlyArray<WorkContractRevisionRecord>,
    WorkRepositoryError,
    TransactionScope
  >;
}

export class WorkContractRevisionRepository extends Context.Service<
  WorkContractRevisionRepository,
  WorkContractRevisionRepositoryService
>()("arbor/WorkContractRevisionRepository") {}
