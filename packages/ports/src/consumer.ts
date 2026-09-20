import type { DomainEvent } from "@arbor/domain";
import { Context, type Effect } from "effect";
import type {
  ConsumerDeadLetterStoreError,
  ConsumerOffsetStoreError,
} from "./errors.js";
import type { TransactionScope } from "./session.js";

export interface ConsumerOffsetStoreService {
  readonly read: (
    consumerId: string,
    projectId: string,
  ) => Effect.Effect<number, ConsumerOffsetStoreError, TransactionScope>;
  readonly advance: (
    consumerId: string,
    projectId: string,
    lastSequence: number,
  ) => Effect.Effect<void, ConsumerOffsetStoreError, TransactionScope>;
}

export class ConsumerOffsetStore extends Context.Service<
  ConsumerOffsetStore,
  ConsumerOffsetStoreService
>()("arbor/ConsumerOffsetStore") {}

export interface ConsumerDeadLetterStoreService {
  readonly quarantine: (
    consumerId: string,
    projectId: string,
    sequence: number,
    reason: string,
  ) => Effect.Effect<void, ConsumerDeadLetterStoreError, TransactionScope>;
}

export class ConsumerDeadLetterStore extends Context.Service<
  ConsumerDeadLetterStore,
  ConsumerDeadLetterStoreService
>()("arbor/ConsumerDeadLetterStore") {}

export interface ProjectionStoreService {
  readonly apply: (
    batch: ReadonlyArray<DomainEvent<unknown>>,
  ) => Effect.Effect<void, ConsumerOffsetStoreError, TransactionScope>;
  readonly reset: () => Effect.Effect<
    void,
    ConsumerOffsetStoreError,
    TransactionScope
  >;
}

export class ProjectionStore extends Context.Service<
  ProjectionStore,
  ProjectionStoreService
>()("arbor/ProjectionStore") {}
