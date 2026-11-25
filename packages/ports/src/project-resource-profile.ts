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

/** P1 application port backed by startup Profiles and append-only host
 * directory registrations. Its list is path-free; resolution performs no I/O. */
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
