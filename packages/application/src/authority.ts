import type {
  CommandId,
  Principal,
  ProjectId,
  SemanticRequestFingerprint,
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
    };

export interface CommandAuthorityRule<C> {
  readonly tag: VerifiedCommandAuthority["_tag"];
  readonly targetMatches: (
    authority: VerifiedCommandAuthority,
    payload: C,
  ) => boolean;
}

export interface CommandAuthorityFacts<C> {
  readonly principal: Principal;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly semanticRequestFingerprint: SemanticRequestFingerprint;
  readonly payload: C;
}

/**
 * Deterministic exact-match validation (`01-command-contracts.md` §2A).
 * `None` = authorized; `Some(reason)` = `AuthorityDenied`.
 */
export const validateCommandAuthority = <C>(
  authority: VerifiedCommandAuthority,
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
  if (!rule.targetMatches(authority, facts.payload)) {
    return Option.some("authority target mismatch");
  }
  return Option.none();
};
