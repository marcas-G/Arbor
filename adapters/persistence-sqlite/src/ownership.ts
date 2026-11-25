import {
  Clock,
  DomainEventJournal,
  EnvironmentRevisionStore,
  IdGenerator,
  OwnershipWriteService,
  ProjectEnvironmentPort,
  ResourceOwnershipRepository,
  TransactionPort,
  WorkspaceRepository,
  WorkspaceResourceActivationStore,
} from "@arbor/ports";
import {
  Effect,
  Layer,
} from "effect";
import {
  SqlClient,
} from "effect/unstable/sql/SqlClient";
import type { WorkspaceResourceActivationQualificationProbe } from "./ownership/claim-codec.js";
import { makeOwnershipContext } from "./ownership/context.js";
import { makeActivationWrites } from "./ownership/activation.js";
import { makeDelegationWrites } from "./ownership/delegation.js";
import { makeReclamationWrites } from "./ownership/reclamation.js";

export type { WorkspaceResourceActivationQualificationEvent, WorkspaceResourceActivationQualificationProbe } from "./ownership/claim-codec.js";
export { ResourceOwnershipRepositoryLive } from "./ownership/repository.js";
export { EnvironmentRevisionStoreLive } from "./ownership/environment-revision.js";

const makeOwnershipWriteServiceEffect = (qualificationProbe?: WorkspaceResourceActivationQualificationProbe) =>
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

