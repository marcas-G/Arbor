import type {
  SandboxAuthorityBundleSnapshotCurrent,
  SandboxAuthorityLoadErrorV1,
  SandboxPolicyCurrentHostV1,
} from "@arbor/domain";
import { Context, type Effect } from "effect";

export type CurrentSandboxAuthoritySnapshotV2Result =
  | {
      readonly _tag: "Available";
      readonly snapshot: SandboxAuthorityBundleSnapshotCurrent;
      readonly currentHost: SandboxPolicyCurrentHostV1;
    }
  | {
      readonly _tag: "Unavailable";
      readonly failure:
        | SandboxAuthorityLoadErrorV1
        | "CurrentHostIdentityUnavailable";
    };

/** P5-owned, read-only seam for consumers that need current authority state.
 * Every call revalidates the protected current V2|V3 source/high-water pair. */
export interface CurrentSandboxAuthoritySnapshotPortService {
  readonly loadCurrentVerifiedV2: () => Effect.Effect<CurrentSandboxAuthoritySnapshotV2Result>;
}

export class CurrentSandboxAuthoritySnapshotPort extends Context.Service<
  CurrentSandboxAuthoritySnapshotPort,
  CurrentSandboxAuthoritySnapshotPortService
>()("arbor/CurrentSandboxAuthoritySnapshotPort") {}
