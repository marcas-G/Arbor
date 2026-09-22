import type {
  AcceptanceId,
  Actor,
  CommandId,
  DependencyId,
  FormationProposalId,
  MessageId,
  Principal,
  ProjectId,
  VerificationId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import { Effect, Option } from "effect";

// --- P10 `05` §2 (GQ4/GQ6): the four user-action surfaces (SD §12.5;
// UI only issues Commands — SD §13.10) --------------------------------------
//
// Every surface submits an EXISTING, unchanged command through the
// injected CommandGateway face; none writes storage directly. The
// gateway face is structural (transport-neutral): P12 binds the real
// transports to the same api-contracts DTO surface. No HTTP/WebSocket/
// CLI anywhere in this tree.

export interface ActionEnvelope<P> {
  readonly commandType: string;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly actor: Actor;
  readonly issuedAt: string;
  readonly payload: P;
}

export interface ActionSubmissionContext {
  readonly _tag: "External";
  readonly principal: Principal;
}

/** Host-validated authority fact carrier — the surface NEVER mints
 * authority; it forwards the fact the trusted host resolved. */
export interface ActionAuthorityCarrier {
  readonly _tag: string;
  readonly principal: Principal;
}

export interface ActionReceipt {
  readonly resolution:
    | { readonly _tag: "Committed" }
    | { readonly _tag: "TerminalRejected"; readonly error?: unknown };
}

/** Typed surface refusal (never a gateway rejection): the surface rule
 * itself (human-only verb, invalid severity, ...) failed before any
 * submission. */
export interface ActionSurfaceRefusal {
  readonly _tag: "ActionSurfaceRefusal";
  readonly reason: string;
}

/** The gateway submission failed on its own error channel — the cause is
 * the host gateway's typed error, carried opaquely (adapter errors never
 * cross the surface boundary). */
export interface ActionSubmissionFailure {
  readonly _tag: "ActionSubmissionFailure";
  readonly cause: unknown;
}

export type ActionError = ActionSurfaceRefusal | ActionSubmissionFailure;

/** The CommandGateway face (structural). Method syntax keeps the real
 * application gateway assignable (bivariant parameter check). */
export interface ActionGateway {
  execute(
    envelope: ActionEnvelope<unknown>,
    context: ActionSubmissionContext,
    authority: ActionAuthorityCarrier,
  ): Effect.Effect<ActionReceipt, unknown>;
}

const refuse = (reason: string): ActionSurfaceRefusal => ({
  _tag: "ActionSurfaceRefusal",
  reason,
});

const submissionFailure = (cause: unknown): ActionSubmissionFailure => ({
  _tag: "ActionSubmissionFailure",
  cause,
});

const humanPrincipalOf = (
  authority: ActionAuthorityCarrier,
): Option.Option<Principal> =>
  authority.principal.startsWith("user:")
    ? Option.some(authority.principal)
    : Option.none();

// --- Query surface (BLK-2 fix: message-mediated) ----------------------------
//
// The surface submits a Query MESSAGE to the target workspace via the P6
// SendMessage channel. The workspace's cognition side spawns the P14
// Execution-bound read-only query execution (P8 `05` program, consumed
// as-is) and flows the result back as a Message into the requesting
// Inbox. External AdmitExecution is resolver-gated exactly like Stop
// (P12, GQ4) — this surface NEVER calls it directly.

export interface QuerySurfaceRequest {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly actor: Actor;
  readonly issuedAt: string;
  readonly messageId: MessageId;
  /** The requesting workspace — Query may only target its ancestors
   * (P6 `02` §2; the handler enforces the frozen rule). */
  readonly senderWorkspaceId: WorkspaceId;
  readonly targetWorkspaceId: WorkspaceId;
  readonly bodyRef: string;
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
  /** SendMessageAuthority-shaped carrier resolved by the host. */
  readonly authority: ActionAuthorityCarrier & {
    readonly senderWorkspaceId: WorkspaceId;
  };
}

export const submitQueryRequest = (
  gateway: ActionGateway,
  request: QuerySurfaceRequest,
): Effect.Effect<ActionReceipt, ActionError> =>
  Effect.gen(function* () {
    if (request.bodyRef.length === 0) {
      return yield* Effect.fail(refuse("query bodyRef must be non-empty"));
    }
    const payload = {
      messageId: request.messageId,
      senderWorkspaceId: request.senderWorkspaceId,
      message: {
        kind: "Query" as const,
        recipientWorkspaceId: request.targetWorkspaceId,
        bodyRef: request.bodyRef,
        urgency: "Normal" as const,
        ...(request.correlationId === undefined
          ? {}
          : { correlationId: request.correlationId }),
        ...(request.causationId === undefined
          ? {}
          : { causationId: request.causationId }),
      },
    };
    return yield* gateway
      .execute(
        {
          commandType: "SendMessage",
          commandId: request.commandId,
          projectId: request.projectId,
          actor: request.actor,
          issuedAt: request.issuedAt,
          payload,
        },
        { _tag: "External", principal: request.authority.principal },
        request.authority,
      )
      .pipe(Effect.mapError(submissionFailure));
  });

// --- Steer surface → SteerWork (P6 `04`; severity Normal/Critical, human
// principal) ------------------------------------------------------------------

export interface SteerSurfaceRequest {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly actor: Actor;
  readonly issuedAt: string;
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly expectedWorkRevision: WorkRevision;
  readonly severity: "Normal" | "Critical";
  readonly guidance: string;
  /** SteerWorkAuthority-shaped carrier resolved by the host. */
  readonly authority: ActionAuthorityCarrier & {
    readonly targetWorkspaceId: WorkspaceId;
    readonly workId: WorkId;
  };
}

export const steerRequest = (
  gateway: ActionGateway,
  request: SteerSurfaceRequest,
): Effect.Effect<ActionReceipt, ActionError> =>
  Effect.gen(function* () {
    if (request.severity !== "Normal" && request.severity !== "Critical") {
      return yield* Effect.fail(
        refuse("steer severity must be Normal or Critical"),
      );
    }
    if (Option.isNone(humanPrincipalOf(request.authority))) {
      return yield* Effect.fail(
        refuse("steer surface requires a human-originated principal"),
      );
    }
    const payload = {
      workId: request.workId,
      workspaceId: request.workspaceId,
      steer: {
        severity: request.severity,
        guidance: request.guidance,
      },
      expectedWorkRevision: request.expectedWorkRevision,
      provenance: { source: "HumanInput" as const },
    };
    return yield* gateway
      .execute(
        {
          commandType: "SteerWork",
          commandId: request.commandId,
          projectId: request.projectId,
          actor: request.actor,
          issuedAt: request.issuedAt,
          payload,
        },
        { _tag: "External", principal: request.authority.principal },
        request.authority,
      )
      .pipe(Effect.mapError(submissionFailure));
  });

// --- Stop request surface → StopExecution (P2; request ONLY) ----------------
//
// P10 exposes the REQUEST ONLY: the request carries a human principal
// identifier and is submitted exactly like any external command — P2
// validates trusted Stop authority as frozen. No resolver is implemented
// here (GQ4): trusted-authority resolution is P12.

export interface StopSurfaceRequest {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly actor: Actor;
  readonly issuedAt: string;
  readonly executionId: string;
  /** StopExecutionAuthority-shaped carrier resolved by the host. Runtime
   * stop authority facts carry a submission origin — an external stop
   * request stays the typed rejection until the P12 resolver lands. */
  readonly authority: ActionAuthorityCarrier & {
    readonly executionId: string;
    readonly submissionOrigin?: string;
  };
}

export const stopRequest = (
  gateway: ActionGateway,
  request: StopSurfaceRequest,
): Effect.Effect<ActionReceipt, ActionError> =>
  Effect.gen(function* () {
    if (Option.isNone(humanPrincipalOf(request.authority))) {
      return yield* Effect.fail(
        refuse("stop request surface requires a human-originated principal"),
      );
    }
    const payload = { executionId: request.executionId };
    return yield* gateway
      .execute(
        {
          commandType: "StopExecution",
          commandId: request.commandId,
          projectId: request.projectId,
          actor: request.actor,
          issuedAt: request.issuedAt,
          payload,
        },
        { _tag: "External", principal: request.authority.principal },
        request.authority,
      )
      .pipe(Effect.mapError(submissionFailure));
  });

// --- Governance Change entry (presentation over the existing governance
// commands — P10 `05` §2; the P10 `06` §2 emission set) -----------------------

export type GovernanceEntry =
  | {
      readonly kind: "FormationApproval";
      readonly proposalId: FormationProposalId;
      readonly expectedProposalRevision: number;
      readonly outcome: "Approve" | "Reject" | "Modify";
    }
  | {
      readonly kind: "AcceptWorkOutcome";
      readonly acceptanceId: AcceptanceId;
      readonly workId: WorkId;
      readonly targetWorkRevision: WorkRevision;
      readonly verificationId: VerificationId;
    }
  | {
      readonly kind: "WithdrawDependency";
      readonly dependencyId: DependencyId;
      readonly targetDependencyRevision: number;
      readonly reason: string;
    }
  | {
      readonly kind: "MarkDependencyUnfulfillable";
      readonly dependencyId: DependencyId;
      readonly targetDependencyRevision: number;
      readonly justification: string;
    };

const GOVERNANCE_COMMAND_OF: Record<GovernanceEntry["kind"], string> = {
  FormationApproval: "RecordDecision",
  AcceptWorkOutcome: "AcceptWorkOutcome",
  WithdrawDependency: "WithdrawDependency",
  MarkDependencyUnfulfillable: "MarkDependencyUnfulfillable",
};

const governancePayloadOf = (entry: GovernanceEntry): unknown => {
  switch (entry.kind) {
    case "FormationApproval":
      return {
        proposalId: entry.proposalId,
        expectedProposalRevision: entry.expectedProposalRevision,
        outcome: entry.outcome,
      };
    case "AcceptWorkOutcome":
      return {
        acceptanceId: entry.acceptanceId,
        workId: entry.workId,
        targetWorkRevision: entry.targetWorkRevision,
        verificationId: entry.verificationId,
      };
    case "WithdrawDependency":
      return {
        dependencyId: entry.dependencyId,
        targetDependencyRevision: entry.targetDependencyRevision,
        reason: entry.reason,
      };
    case "MarkDependencyUnfulfillable":
      return {
        dependencyId: entry.dependencyId,
        targetDependencyRevision: entry.targetDependencyRevision,
        justification: entry.justification,
      };
  }
};

export interface GovernanceSurfaceRequest {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly actor: Actor;
  readonly issuedAt: string;
  readonly entry: GovernanceEntry;
  /** Command-specific authority carrier resolved by the host. */
  readonly authority: ActionAuthorityCarrier;
}

/** Governance Change entry presentation: submits the chosen existing
 * governance command via the gateway. The four human-originated mutating
 * commands (RecordDecision formation approval, AcceptWorkOutcome,
 * WithdrawDependency, MarkDependencyUnfulfillable) are exactly the
 * GovernanceDecision emission set (P10 `06` §2) — the surface requires a
 * human principal for the entry presentation. */
export const governanceEntryRequest = (
  gateway: ActionGateway,
  request: GovernanceSurfaceRequest,
): Effect.Effect<ActionReceipt, ActionError> =>
  Effect.gen(function* () {
    if (Option.isNone(humanPrincipalOf(request.authority))) {
      return yield* Effect.fail(
        refuse(
          "governance entry surface requires a human-originated principal",
        ),
      );
    }
    return yield* gateway
      .execute(
        {
          commandType: GOVERNANCE_COMMAND_OF[request.entry.kind],
          commandId: request.commandId,
          projectId: request.projectId,
          actor: request.actor,
          issuedAt: request.issuedAt,
          payload: governancePayloadOf(request.entry),
        },
        { _tag: "External", principal: request.authority.principal },
        request.authority,
      )
      .pipe(Effect.mapError(submissionFailure));
  });

/** Surface verb labels (SD §12.5 four verbs) — consumed by renderers. */
export const ACTION_SURFACE_VERBS = [
  "Query",
  "Steer",
  "Stop",
  "GovernanceChange",
] as const;

export type ActionSurfaceVerb = (typeof ACTION_SURFACE_VERBS)[number];
