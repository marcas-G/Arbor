import { Schema } from "effect";

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuidV7 = (value: string): boolean => UUID_V7_RE.test(value);

const makeIdSchema = <B extends string>(prefix: string, brand: B) =>
  Schema.String.pipe(
    Schema.refine(
      (value): value is string =>
        value.startsWith(prefix) && isUuidV7(value.slice(prefix.length)),
      { message: `expected ${prefix}<uuid-v7>` },
    ),
    Schema.brand(brand),
  );

export const ID_PREFIXES = {
  ProjectId: "prj_",
  WorkspaceId: "ws_",
  WorkId: "wrk_",
  ExecutionId: "exe_",
  SessionId: "ses_",
  VerificationId: "ver_",
  DependencyId: "dep_",
  DeliverableId: "del_",
  MessageId: "msg_",
  ArtifactId: "art_",
  DecisionId: "dec_",
  PermissionGrantId: "pgr_",
  AcceptanceId: "acc_",
  EvidenceId: "evd_",
  MemoryId: "mem_",
  CommandId: "cmd_",
  EventId: "evt_",
  ProviderTurnId: "ptn_",
  ToolInvocationId: "tin_",
  WorkerId: "wkr_",
  FormationProposalId: "fpr_",
} as const;

export type IdTypeName = keyof typeof ID_PREFIXES;

export const ProjectId = makeIdSchema(ID_PREFIXES.ProjectId, "ProjectId");
export const WorkspaceId = makeIdSchema(ID_PREFIXES.WorkspaceId, "WorkspaceId");
export const WorkId = makeIdSchema(ID_PREFIXES.WorkId, "WorkId");
export const ExecutionId = makeIdSchema(ID_PREFIXES.ExecutionId, "ExecutionId");
export const SessionId = makeIdSchema(ID_PREFIXES.SessionId, "SessionId");
export const VerificationId = makeIdSchema(
  ID_PREFIXES.VerificationId,
  "VerificationId",
);
export const DependencyId = makeIdSchema(
  ID_PREFIXES.DependencyId,
  "DependencyId",
);
export const DeliverableId = makeIdSchema(
  ID_PREFIXES.DeliverableId,
  "DeliverableId",
);
export const MessageId = makeIdSchema(ID_PREFIXES.MessageId, "MessageId");
export const ArtifactId = makeIdSchema(ID_PREFIXES.ArtifactId, "ArtifactId");
export const DecisionId = makeIdSchema(ID_PREFIXES.DecisionId, "DecisionId");
export const PermissionGrantId = makeIdSchema(
  ID_PREFIXES.PermissionGrantId,
  "PermissionGrantId",
);
export const AcceptanceId = makeIdSchema(
  ID_PREFIXES.AcceptanceId,
  "AcceptanceId",
);
export const EvidenceId = makeIdSchema(ID_PREFIXES.EvidenceId, "EvidenceId");
export const MemoryId = makeIdSchema(ID_PREFIXES.MemoryId, "MemoryId");
export const CommandId = makeIdSchema(ID_PREFIXES.CommandId, "CommandId");
export const EventId = makeIdSchema(ID_PREFIXES.EventId, "EventId");
export const ProviderTurnId = makeIdSchema(
  ID_PREFIXES.ProviderTurnId,
  "ProviderTurnId",
);
export const ToolInvocationId = makeIdSchema(
  ID_PREFIXES.ToolInvocationId,
  "ToolInvocationId",
);
export const WorkerId = makeIdSchema(ID_PREFIXES.WorkerId, "WorkerId");
export const FormationProposalId = makeIdSchema(
  ID_PREFIXES.FormationProposalId,
  "FormationProposalId",
);

export const ID_SCHEMAS = {
  ProjectId,
  WorkspaceId,
  WorkId,
  ExecutionId,
  SessionId,
  VerificationId,
  DependencyId,
  DeliverableId,
  MessageId,
  ArtifactId,
  DecisionId,
  PermissionGrantId,
  AcceptanceId,
  EvidenceId,
  MemoryId,
  CommandId,
  EventId,
  ProviderTurnId,
  ToolInvocationId,
  WorkerId,
  FormationProposalId,
} as const satisfies Record<IdTypeName, unknown>;

export type ProjectId = Schema.Schema.Type<typeof ProjectId>;
export type WorkspaceId = Schema.Schema.Type<typeof WorkspaceId>;
export type WorkId = Schema.Schema.Type<typeof WorkId>;
export type ExecutionId = Schema.Schema.Type<typeof ExecutionId>;
export type SessionId = Schema.Schema.Type<typeof SessionId>;
export type VerificationId = Schema.Schema.Type<typeof VerificationId>;
export type DependencyId = Schema.Schema.Type<typeof DependencyId>;
export type DeliverableId = Schema.Schema.Type<typeof DeliverableId>;
export type MessageId = Schema.Schema.Type<typeof MessageId>;
export type ArtifactId = Schema.Schema.Type<typeof ArtifactId>;
export type DecisionId = Schema.Schema.Type<typeof DecisionId>;
export type PermissionGrantId = Schema.Schema.Type<typeof PermissionGrantId>;
export type AcceptanceId = Schema.Schema.Type<typeof AcceptanceId>;
export type EvidenceId = Schema.Schema.Type<typeof EvidenceId>;
export type MemoryId = Schema.Schema.Type<typeof MemoryId>;
export type CommandId = Schema.Schema.Type<typeof CommandId>;
export type EventId = Schema.Schema.Type<typeof EventId>;
export type ProviderTurnId = Schema.Schema.Type<typeof ProviderTurnId>;
export type ToolInvocationId = Schema.Schema.Type<typeof ToolInvocationId>;
export type WorkerId = Schema.Schema.Type<typeof WorkerId>;
export type FormationProposalId = Schema.Schema.Type<
  typeof FormationProposalId
>;

export const PREFIX_TO_ID: Record<string, IdTypeName> = Object.fromEntries(
  Object.entries(ID_PREFIXES).map(([name, prefix]) => [
    prefix,
    name as IdTypeName,
  ]),
);

const uuidV7 = (timeMs: number, random: Uint8Array): string => {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0 || timeMs > 0xffffffffffff) {
    throw new RangeError("uuid v7 timestamp out of range");
  }
  if (random.length !== 10) {
    throw new RangeError("uuid v7 requires exactly 10 random bytes");
  }
  const b = (index: number): number => random[index] ?? 0;
  const bytes = new Uint8Array(16);
  bytes[0] = Math.floor(timeMs / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timeMs / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timeMs / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timeMs / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timeMs / 2 ** 8) & 0xff;
  bytes[5] = timeMs & 0xff;
  bytes[6] = 0x70 | (b(0) & 0x0f);
  bytes[7] = b(1);
  bytes[8] = 0x80 | (b(2) & 0x3f);
  bytes[9] = b(3);
  bytes[10] = b(4);
  bytes[11] = b(5);
  bytes[12] = b(6);
  bytes[13] = b(7);
  bytes[14] = b(8);
  bytes[15] = b(9);
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const generate = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  prefix: string,
) => {
  const decode = Schema.decodeUnknownSync(schema);
  return (timeMs: number, random: Uint8Array): S["Type"] =>
    decode(`${prefix}${uuidV7(timeMs, random)}`);
};

export const parse = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(schema);

export const encode = <S extends Schema.ConstraintEncoder<unknown>>(
  schema: S,
) => Schema.encodeSync(schema);
