import { Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  makeAttentionProjectionStoreLive,
  makeRecoveryAttentionFactStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import type {
  DomainEventJournal,
  IdGenerator,
} from "../../packages/ports/src/index.js";

/**
 * Legacy phase fixtures intentionally stop before migration 0041. These live
 * adapters expose their typed unavailable/empty-source behavior against that
 * schema: P41 availability is false, while older fact stores remain usable.
 */
export const makeP41OptionalTestServices = <E, R>(
  dependencies: Layer.Layer<SqlClient | DomainEventJournal | IdGenerator, E, R>,
) =>
  Layer.mergeAll(
    Layer.provide(makeRecoveryAttentionFactStoreLive(), dependencies),
    Layer.provide(makeAttentionProjectionStoreLive(), dependencies),
  );
