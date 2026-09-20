import * as ports from "@arbor/ports";
import {
  CommandStore,
  ConsumerDeadLetterStore,
  ConsumerOffsetStore,
  DomainEventJournal,
  EnvironmentRevisionStore,
  IdGenerator,
  OwnershipWriteService,
  ProjectEnvironmentPort,
  ProjectionStore,
  ProjectRepository,
  ResourceOwnershipRepository,
  SessionRepository,
  TransactionPort,
  TransactionScope,
  WorkRepository,
  WorkspaceRepository,
} from "@arbor/ports";
import type { Effect } from "effect";
import { describe, expect, it } from "vitest";

describe("ports contracts", () => {
  it("exposes every frozen P1 service", () => {
    for (const tag of [
      TransactionScope,
      TransactionPort,
      ProjectRepository,
      WorkspaceRepository,
      WorkRepository,
      SessionRepository,
      ResourceOwnershipRepository,
      CommandStore,
      DomainEventJournal,
      ConsumerOffsetStore,
      ConsumerDeadLetterStore,
      ProjectionStore,
      EnvironmentRevisionStore,
      ProjectEnvironmentPort,
      OwnershipWriteService,
      ports.Clock,
      IdGenerator,
    ]) {
      expect(tag).toBeDefined();
    }
  });

  it("declares no universal RepositoryError", () => {
    expect("RepositoryError" in ports).toBe(false);
  });

  it("type-level: repository methods require TransactionScope", () => {
    type FindById = ReturnType<ProjectRepository["Service"]["findById"]>;
    type FindByIdR =
      FindById extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;
    const requiresScope: TransactionScope extends FindByIdR ? true : false =
      true;
    expect(requiresScope).toBe(true);
  });
});
