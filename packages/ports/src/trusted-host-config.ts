import { Context } from "effect";

/** P5 trusted deployment source. Implementations must verify OS protection
 * and enforce the source-owned monotone revision/high-water contract before
 * returning this startup snapshot. This port is never backed by request,
 * Workspace, Worktree or inherited-environment values. */
export interface TrustedHostConfigurationSourceService {
  readonly readVerified: (
    key: "sandboxPolicyGrantIssuerConfigV1",
  ) => unknown | undefined;
}

export class TrustedHostConfigurationSource extends Context.Service<
  TrustedHostConfigurationSource,
  TrustedHostConfigurationSourceService
>()("arbor/TrustedHostConfigurationSource") {}
