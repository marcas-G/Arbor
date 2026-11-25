import { Actor, parse } from "@arbor/domain";
import {
  Clock,
  DomainEventJournal,
  EnvironmentResolverPort,
  EnvironmentRevisionStore,
  IdGenerator,
  ProjectEnvironmentPort,
  ResourceOwnershipRepository,
  TransactionPort,
  WorkspaceRepository,
  WorkspaceResourceActivationStore,
} from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { WorkspaceResourceActivationQualificationProbe } from "./claim-codec.js";

export const makeOwnershipContext = (
  qualificationProbe?: WorkspaceResourceActivationQualificationProbe,
) =>
  Effect.gen(function* () {
    const environment = yield* ProjectEnvironmentPort;
    const environmentResolver = yield* Effect.serviceOption(
      EnvironmentResolverPort,
    );
    const tx = yield* TransactionPort;
    const sql = yield* SqlClient;
    const runOwnershipQuery = <A extends object>(
      statement: string,
      parameters: ReadonlyArray<unknown> = [],
    ) =>
      Effect.mapError(sql.unsafe<A>(statement, parameters), (cause) => ({
        _tag: "TransactionOperationalFailure" as const,
        cause,
      }));
    const repository = yield* ResourceOwnershipRepository;
    const revisions = yield* EnvironmentRevisionStore;
    const clock = yield* Clock;
    const workspaces = yield* WorkspaceRepository;
    const activationIntents = yield* WorkspaceResourceActivationStore;
    const journal = yield* DomainEventJournal;
    const ids = yield* IdGenerator;
    const activationActor = parse(Actor)(
      "system:workspace-resource-activation",
    );

    return {
      environment,
      environmentResolver,
      tx,
      sql,
      runOwnershipQuery,
      repository,
      revisions,
      clock,
      workspaces,
      activationIntents,
      journal,
      ids,
      activationActor,
      qualificationProbe,
    };
  });
export type OwnershipContext = Effect.Success<
  ReturnType<typeof makeOwnershipContext>
>;
