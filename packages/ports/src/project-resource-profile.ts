import type { ResourceAddress } from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";

export interface ProjectResourceProfileSummary {
  readonly resourceProfileRef: string;
  readonly version: string;
  readonly displayName: string;
  readonly available: boolean;
}

export interface TrustedProjectResourceProfile
  extends ProjectResourceProfileSummary {
  readonly available: true;
  readonly canonicalAddress: Extract<
    ResourceAddress,
    { readonly _tag: "FileTree" }
  >;
}

/** P1 application port backed by a host-owned immutable P12 startup snapshot.
 * It exposes no path on its list face and performs no filesystem I/O. */
export interface ProjectResourceProfilePortService {
  readonly list: () => Effect.Effect<
    ReadonlyArray<ProjectResourceProfileSummary>,
    never
  >;
  readonly resolve: (
    resourceProfileRef: string,
    version: string,
  ) => Effect.Effect<Option.Option<TrustedProjectResourceProfile>, never>;
}

export class ProjectResourceProfilePort extends Context.Service<
  ProjectResourceProfilePort,
  ProjectResourceProfilePortService
>()("arbor/ProjectResourceProfilePort") {}
