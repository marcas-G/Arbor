import type { InboxEntry, ProjectId, WorkspaceId } from "@arbor/domain";
import type {
  ExecutableApprovalRecord,
  ModelFacingToolDefinition,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { ProjectionReadError } from "./errors.js";
import type {
  ExecutableApprovalInboxTargetView,
  InboxUnconsumedEntryView,
} from "./views/shared.js";

export type { InboxUnconsumedEntryView };

// --- P10 `01` §1 Inbox view (P9 `05` §3.2; SD §7.4; P10 `05` §1 cores) --
//
// P6 owns inbox semantics; P10 owns the view/query face. The store is
// command-path maintained (not event-replayed), so the per-row watermark
// renders the journal sequence the row set is current as of — the read-
// time canonical lastSequence (admission commits in the same transaction
// as the journal append). Read-only.

/** Mirrors the frozen InboxViewRes core. */
export interface InboxViewView {
  readonly unconsumed: ReadonlyArray<InboxUnconsumedEntryView>;
}

export interface InboxViewDeps {
  readonly listUnconsumedInbox: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<InboxEntry>, ProjectionReadError>;
  readonly journalLastSequence: (
    projectId: ProjectId,
  ) => Effect.Effect<number, ProjectionReadError>;
  readonly projectIdOfWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ProjectId, ProjectionReadError>;
  /** Read-only, proven Executable-route ActionApproval lookup. */
  readonly findExecutableApproval: (
    approvalId: string,
  ) => Effect.Effect<
    Option.Option<ExecutableApprovalRecord>,
    ProjectionReadError
  >;
  /** Resolves the approved action's exact ToolDefinition hash through its
   * durable AgentLoopStep → ProviderTurn manifest binding. */
  readonly findToolDefinitionHash: (
    approval: ExecutableApprovalRecord,
  ) => Effect.Effect<Option.Option<string>, ProjectionReadError>;
  /** Resolves the unique project-catalogued tool definition for this exact
   * name/version/hash identity. Ambiguous, missing, or unavailable definitions
   * fail closed at the review boundary. */
  readonly resolveToolDefinition: (
    projectId: ProjectId,
    toolName: string,
    toolVersion: string,
    toolDefinitionHash: string,
  ) => Effect.Effect<
    Option.Option<ModelFacingToolDefinition>,
    ProjectionReadError
  >;
}

const REVIEW_UNAVAILABLE = {
  _tag: "ExecutableApprovalReviewUnavailable",
} as const;

const reviewUnavailable = (): Effect.Effect<never, ProjectionReadError> =>
  Effect.fail({ _tag: "ProjectionReadFailure", cause: REVIEW_UNAVAILABLE });

const approvalIdentityFromInboxKey = (
  entryKey: string,
): { readonly approvalId: string; readonly revision: number } | null => {
  if (!entryKey.startsWith("eap:")) return null;
  const separator = entryKey.lastIndexOf(":");
  if (separator <= "eap:".length || separator === entryKey.length - 1) {
    return null;
  }
  const revisionText = entryKey.slice(separator + 1);
  if (!/^(0|[1-9]\d*)$/.test(revisionText)) return null;
  const revision = Number(revisionText);
  if (!Number.isSafeInteger(revision)) return null;
  return {
    approvalId: entryKey.slice("eap:".length, separator),
    revision,
  };
};

interface ReviewSchema {
  readonly type?: string | ReadonlyArray<string>;
  readonly required?: ReadonlyArray<string>;
  readonly properties?: Readonly<Record<string, ReviewSchema>>;
  readonly items?: ReviewSchema;
  readonly enum?: ReadonlyArray<unknown>;
  readonly format?: string;
  readonly writeOnly?: boolean;
  readonly secret?: boolean;
  readonly "x-sensitive"?: boolean;
}

const SENSITIVE_NAME =
  /password|secret|token|credential|authorization|private.?key|api.?key|auth.?key|cookie|bearer/i;
const PATH_NAME = /path|cwd|file|directory|url|uri/i;
const REDACTED = "[redacted]";
const MAX_PREVIEW_CHARS = 1024;
const MAX_PREVIEW_ITEMS = 16;

const schemaIsSensitive = (schema: ReviewSchema): boolean =>
  schema.writeOnly === true ||
  schema.secret === true ||
  schema["x-sensitive"] === true ||
  schema.format === "password";

const previewValue = (
  value: unknown,
  schema: ReviewSchema,
  propertyName: string,
  depth = 0,
): unknown => {
  if (
    depth > 8 ||
    schemaIsSensitive(schema) ||
    SENSITIVE_NAME.test(propertyName) ||
    PATH_NAME.test(propertyName)
  ) {
    return REDACTED;
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return schema.enum?.includes(value) === true ? value : REDACTED;
  }

  if (Array.isArray(value)) {
    if (schema.items === undefined || value.length > MAX_PREVIEW_ITEMS) {
      return REDACTED;
    }
    return value.map((item) =>
      previewValue(item, schema.items as ReviewSchema, propertyName, depth + 1),
    );
  }

  if (typeof value === "object") {
    const properties = schema.properties;
    if (properties === undefined) return REDACTED;
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      const childSchema = Object.hasOwn(properties, key)
        ? properties[key]
        : undefined;
      if (childSchema === undefined) return REDACTED;
      result[key] = previewValue(item, childSchema, key, depth + 1);
    }
    return result;
  }

  return REDACTED;
};

const validatedArgumentsPreview = (
  argumentsJson: string,
  schemaJson: string,
): string | null => {
  try {
    const schema = JSON.parse(schemaJson) as ReviewSchema;
    const value = JSON.parse(argumentsJson) as unknown;
    if (
      schema.type !== "object" ||
      schema.properties === undefined ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      return null;
    }
    const argumentsObject = value as Record<string, unknown>;
    if (
      (schema.required ?? []).some(
        (key) => argumentsObject[key] === undefined,
      ) ||
      Object.keys(argumentsObject).some(
        (key) =>
          schema.properties === undefined ||
          !Object.hasOwn(schema.properties, key),
      )
    ) {
      return null;
    }
    const preview = previewValue(argumentsObject, schema, "arguments");
    if (typeof preview !== "object" || preview === null) return null;
    const serialized = JSON.stringify(preview);
    return serialized.length <= MAX_PREVIEW_CHARS ? serialized : null;
  } catch {
    return null;
  }
};

const executableApprovalTarget = (
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  entry: InboxEntry,
  deps: InboxViewDeps,
): Effect.Effect<ExecutableApprovalInboxTargetView, ProjectionReadError> =>
  Effect.gen(function* () {
    const identity = approvalIdentityFromInboxKey(entry.entryKey);
    if (identity === null || entry.kind !== "Governance") {
      return yield* reviewUnavailable();
    }

    const stored = yield* deps.findExecutableApproval(identity.approvalId);
    if (Option.isNone(stored)) return yield* reviewUnavailable();
    const approval = stored.value;
    if (
      approval.routeKind !== "Executable" ||
      approval.approvalId !== identity.approvalId ||
      approval.revision !== identity.revision ||
      approval.state !== "Pending" ||
      approval.workspaceId !== workspaceId ||
      approval.projectId !== projectId ||
      approval.executionId.length === 0 ||
      approval.toolName.length === 0 ||
      approval.toolVersion.length === 0 ||
      approval.actionDigest.length === 0 ||
      approval.expiresAt.length === 0
    ) {
      return yield* reviewUnavailable();
    }

    const definitionHashOption = yield* deps.findToolDefinitionHash(approval);
    if (Option.isNone(definitionHashOption)) return yield* reviewUnavailable();
    const definitionHash = definitionHashOption.value;

    const definitionOption = yield* deps.resolveToolDefinition(
      approval.projectId,
      approval.toolName,
      approval.toolVersion,
      definitionHash,
    );
    if (Option.isNone(definitionOption)) return yield* reviewUnavailable();
    const definition = definitionOption.value;
    if (
      definition.name !== approval.toolName ||
      definition.version !== approval.toolVersion ||
      definition.hash !== definitionHash ||
      definition.sideEffectSemantics !== approval.sideEffectSemantics
    ) {
      return yield* reviewUnavailable();
    }

    const argumentsPreview = validatedArgumentsPreview(
      approval.argumentsJson,
      definition.schemaJson,
    );
    if (argumentsPreview === null) return yield* reviewUnavailable();

    return {
      kind: "ExecutableApproval",
      approvalId: approval.approvalId,
      revision: approval.revision,
      executionId: approval.executionId,
      toolName: approval.toolName,
      toolVersion: approval.toolVersion,
      validatedArgumentsPreview: argumentsPreview,
      targetResourceSpaceIds: [...approval.targetResourceSpaceIds],
      capabilities: [...definition.capabilityMetadata],
      sideEffectSemantics: approval.sideEffectSemantics,
      expiresAt: approval.expiresAt,
      actionDigest: approval.actionDigest,
    };
  });

/** InboxViewRes derive — unconsumed rows in admission order, each
 * carrying the read-time journal watermark. */
export const deriveInboxView = (
  workspaceId: WorkspaceId,
  deps: InboxViewDeps,
): Effect.Effect<InboxViewView, ProjectionReadError> =>
  Effect.gen(function* () {
    const projectId = yield* deps.projectIdOfWorkspace(workspaceId);
    const watermark = yield* deps.journalLastSequence(projectId);
    const inbox = yield* deps.listUnconsumedInbox(workspaceId);
    const unconsumed: Array<InboxUnconsumedEntryView> = [];
    for (const entry of inbox) {
      const isExecutableApproval = entry.entryKey.startsWith("eap:");
      const base = {
        entryKey: entry.entryKey,
        kind: entry.kind,
        // Executable inbox summaries are not the source of review data and
        // can be stale or malformed. Do not forward them to the UI.
        summary: isExecutableApproval
          ? "Executable approval requires review"
          : entry.summary,
        watermark,
      };
      if (isExecutableApproval) {
        const target = yield* executableApprovalTarget(
          workspaceId,
          projectId,
          entry,
          deps,
        );
        unconsumed.push({ ...base, target });
      } else {
        unconsumed.push(base);
      }
    }
    return { unconsumed };
  });
