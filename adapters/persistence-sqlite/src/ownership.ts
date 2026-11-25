import {
  type Clock,
  type DomainEventJournal,
  type EnvironmentRevisionStore,
  type IdGenerator,
  OwnershipWriteService,
  type ProjectEnvironmentPort,
  type ResourceOwnershipRepository,
  type TransactionPort,
  type WorkspaceRepository,
  type WorkspaceResourceActivationStore,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { makeActivationWrites } from "./ownership/activation.js";
import type { WorkspaceResourceActivationQualificationProbe } from "./ownership/claim-codec.js";
import { makeOwnershipContext } from "./ownership/context.js";
import { makeDelegationWrites } from "./ownership/delegation.js";
import { makeReclamationWrites } from "./ownership/reclamation.js";

export type {
  WorkspaceResourceActivationQualificationEvent,
  WorkspaceResourceActivationQualificationProbe,
} from "./ownership/claim-codec.js";
export { EnvironmentRevisionStoreLive } from "./ownership/environment-revision.js";
export { ResourceOwnershipRepositoryLive } from "./ownership/repository.js";

const makeOwnershipWriteServiceEffect = (
  qualificationProbe?: WorkspaceResourceActivationQualificationProbe,
) =>
  Effect.gen(function* () {
    const context = yield* makeOwnershipContext(qualificationProbe);
    return OwnershipWriteService.of({
      ...makeActivationWrites(context),
      ...makeDelegationWrites(context),
      ...makeReclamationWrites(context),
    });
  });

export const OwnershipWriteServiceWithQualificationProbe = (
  qualificationProbe?: WorkspaceResourceActivationQualificationProbe,
): Layer.Layer<
  OwnershipWriteService,
  never,
  | ProjectEnvironmentPort
  | SqlClient
  | TransactionPort
  | ResourceOwnershipRepository
  | EnvironmentRevisionStore
  | WorkspaceRepository
  | WorkspaceResourceActivationStore
  | DomainEventJournal
  | IdGenerator
  | Clock
> =>
  Layer.effect(
    OwnershipWriteService,
    makeOwnershipWriteServiceEffect(qualificationProbe),
  );

export const OwnershipWriteServiceLive =
  OwnershipWriteServiceWithQualificationProbe();
