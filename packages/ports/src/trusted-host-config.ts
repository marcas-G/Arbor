import type { SandboxAuthorityLoadErrorV1 } from "@arbor/domain";
import { Context, type Effect } from "effect";

/** P5 trusted deployment source. Implementations must verify OS protection
 * and enforce the source-owned monotone revision/high-water contract before
 * returning this startup snapshot. This port is never backed by request,
 * Workspace, Worktree or inherited-environment values. */
export interface TrustedHostConfigurationSourceService {
  readonly readVerifiedSandboxAuthorityBundle: () => Effect.Effect<
    | {
        readonly sourceIdentity: string;
        readonly canonicalJson: string;
      }
    | undefined,
    SandboxAuthorityLoadErrorV1
  >;
  readonly readSandboxAuthorityHighWater: () => Effect.Effect<
    string | undefined,
    SandboxAuthorityLoadErrorV1
  >;
  /** Durable atomic replace, outside application SQLite. False means the
   * exact high-water tuple could not be committed. */
  readonly commitSandboxAuthorityHighWater: (
    canonicalJson: string,
  ) => Effect.Effect<boolean, SandboxAuthorityLoadErrorV1>;
  /** Append-only sanitized audit sink, also outside application SQLite. */
  readonly appendSandboxAuthorityAudit: (
    canonicalJson: string,
  ) => Effect.Effect<boolean, SandboxAuthorityLoadErrorV1>;
}

export class TrustedHostConfigurationSource extends Context.Service<
  TrustedHostConfigurationSource,
  TrustedHostConfigurationSourceService
>()("arbor/TrustedHostConfigurationSource") {}
