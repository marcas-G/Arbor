import type {
  CommandId,
  ExecutionId,
  FormationProposalId,
  LeaseGeneration,
  Principal,
  ProjectId,
  SemanticRequestFingerprint,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import { Option } from "effect";

export type VerifiedCommandAuthority =
  | {
      readonly _tag: "CreateProjectAuthority";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
    }
  | {
      readonly _tag: "CreateChildWorkspaceAuthority";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly parentWorkspaceId: WorkspaceId;
    }
  | {
      readonly _tag: "AssignWorkAuthority";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly targetWorkspaceId: WorkspaceId;
    }
  | {
      /** DID §1.4 / §8.18A; P5 `01` §3.1. The caller must forward the scheduler
       * evaluator's exact `workId`; the handler applies, never selects. */
      readonly _tag: "SelectCurrentWorkAuthority";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly targetWorkspaceId: WorkspaceId;
    }
  | {
      /** P6 `01` §4.2 / `03` §3 (D1): human-only formation decisions; the
       * principal must be an authenticated human (`user:` prefix by P1
       * convention). Agents cannot decide formation proposals. */
      readonly _tag: "RecordDecisionAuthority";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly proposalId: FormationProposalId;
    }
  | {
      /** P6 `02` §3: sender identity is bound by the authority fact, never
       * free-typed by the model. */
      readonly _tag: "SendMessageAuthority";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly senderWorkspaceId: WorkspaceId;
    }
  | {
      /** P6 `04` §2: steer authority (human or structurally-entitled parent). */
      readonly _tag: "SteerWorkAuthority";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly targetWorkspaceId: WorkspaceId;
      readonly workId: WorkId;
    };

/**
 * P2 command-specific runtime authority facts (P2 `01` §2). Runtime origins
 * only; External human admit/stop is deferred to the Authority Resolver phase.
 */
export type VerifiedRuntimeCommandAuthority =
  | {
      /** P6 `01` §3: specialist spawn admits from an execution origin (the
       * directive handler forwards the owning execution); P2 worker dispatch
       * keeps the System origin. */
      readonly _tag: "AdmitExecutionAuthority";
      readonly submissionOrigin: "System" | "ExecutionOrigin";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly commandKind: "AdmitExecution";
      readonly workspaceId: WorkspaceId;
      readonly bindingKind: "WorkspaceMain" | "ExecutionBound";
    }
  | {
      readonly _tag: "StopExecutionAuthority";
      readonly submissionOrigin: "System" | "ExecutionOrigin";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly commandKind: "StopExecution";
      readonly executionId: ExecutionId;
    }
  | {
      readonly _tag: "SettleExecutionAuthority";
      readonly submissionOrigin: "ExecutionOrigin" | "RecoveryController";
      readonly principal: Principal;
      readonly commandId: CommandId;
      readonly semanticRequestFingerprint: SemanticRequestFingerprint;
      readonly projectId: ProjectId;
      readonly commandKind: "SettleExecution";
      readonly executionId: ExecutionId;
      readonly fencingGeneration?: LeaseGeneration;
    };

export type CommandAuthorityFact =
  | VerifiedCommandAuthority
  | VerifiedRuntimeCommandAuthority;

/**
 * Stop-admission policy (P2 `01` §3). An explicit ADT, never a boolean.
 * `Unclassified` is valid only for System / RecoveryController origins.
 */
export type StopAdmission =
  | { readonly _tag: "NormalExecutionMutation" }
  | { readonly _tag: "QuiescenceControlMutation" }
  | { readonly _tag: "StopControl" }
  | { readonly _tag: "Unclassified" };

export interface CommandAuthorityRule<C> {
  readonly tag: CommandAuthorityFact["_tag"];
  readonly targetMatches: (
    authority: CommandAuthorityFact,
    payload: C,
  ) => boolean;
}

export interface CommandAuthorityFacts<C> {
  readonly principal: Principal;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly semanticRequestFingerprint: SemanticRequestFingerprint;
  readonly submissionOrigin: string;
  readonly payload: C;
}

const submissionOriginOf = (authority: CommandAuthorityFact): string | null =>
  "submissionOrigin" in authority ? authority.submissionOrigin : null;

/**
 * Deterministic exact-match validation (`01` §2A / P2 `01` §4).
 * `None` = authorized; `Some(reason)` = `AuthorityDenied`.
 */
export const validateCommandAuthority = <C>(
  authority: CommandAuthorityFact,
  rule: CommandAuthorityRule<C>,
  facts: CommandAuthorityFacts<C>,
): Option.Option<string> => {
  if (authority._tag !== rule.tag) {
    return Option.some(`authority kind mismatch: expected ${rule.tag}`);
  }
  if (authority.principal !== facts.principal) {
    return Option.some("authority principal mismatch");
  }
  if (authority.commandId !== facts.commandId) {
    return Option.some("authority commandId mismatch");
  }
  if (
    authority.semanticRequestFingerprint !== facts.semanticRequestFingerprint
  ) {
    return Option.some("authority fingerprint mismatch");
  }
  if (authority.projectId !== facts.projectId) {
    return Option.some("authority projectId mismatch");
  }
  const origin = submissionOriginOf(authority);
  if (origin !== null && origin !== facts.submissionOrigin) {
    return Option.some("authority submission origin mismatch");
  }
  if (!rule.targetMatches(authority, facts.payload)) {
    return Option.some("authority target mismatch");
  }
  return Option.none();
};
