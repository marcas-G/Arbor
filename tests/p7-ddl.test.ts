import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P7_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandId,
  type DeliverableId,
  type DeliverableKind,
  type DependencyId,
  declareDependency,
  parse,
  satisfyDependency,
  WorkId,
} from "../packages/domain/dist/index.js";
import {
  DeliverableRepository,
  DependencyRepository,
  TransactionPort,
} from "../packages/ports/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
  runP7,
} from "./support/p7-app.js";

const DEP_1 = parse(
  (await import("../packages/domain/dist/index.js")).DependencyId,
)("dep_00000000-0000-7000-8000-000000000001");
const DEL_1 = parse(
  (await import("../packages/domain/dist/index.js")).DeliverableId,
)("del_00000000-0000-7000-8000-000000000001");
const WORK_1 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const ASSIGN_CMD = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");

const seed = Effect.gen(function* () {
  yield* runMigrations(P7_MIGRATIONS);
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD);
  expect(receipt.resolution._tag).toBe("Committed");
});

const dependencyOf = () =>
  declareDependency({
    dependencyId: DEP_1 as DependencyId,
    consumerWorkId: WORK_1,
    producerBinding: { _tag: "AnyProducer" },
    revision: 0 as never,
    expectedDeliverable: {
      kind: "report" as never as DeliverableKind,
      requiredArtifactRoles: ["summary" as never],
    },
  });

describe("P7-002 DDL + repositories", () => {
  it("migration id 6 creates the three tables", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient;
        const tables = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('dependencies','deliverables','deliverable_artifacts')",
        );
        expect(tables.map((t) => t.name).sort()).toEqual([
          "deliverable_artifacts",
          "deliverables",
          "dependencies",
        ]);
      }),
      makeP7App(),
    );
  });

  it("dependency CAS: first committer wins, stale replay observes None", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const deps = yield* DependencyRepository;
        const declared = dependencyOf();
        yield* tx.transact(deps.insert(declared, p7Project));
        const satisfied = satisfyDependency(declared, {
          deliverableId: DEL_1 as DeliverableId,
          sourceWorkId: WORK_1,
          sourceWorkspaceId: p7RootWorkspace,
          kind: "report" as never as DeliverableKind,
          artifactRoles: new Set(["summary" as never]),
        });
        expect(satisfied.ok).toBe(true);
        if (satisfied.ok) {
          const first = yield* tx.transact(
            deps.transitionIfUnsatisfiedRevision(
              DEP_1 as DependencyId,
              declared.revision,
              satisfied.value,
            ),
          );
          expect(Option.isSome(first)).toBe(true);
          const replay = yield* tx.transact(
            deps.transitionIfUnsatisfiedRevision(
              DEP_1 as DependencyId,
              declared.revision,
              satisfied.value,
            ),
          );
          expect(Option.isNone(replay)).toBe(true);
          const after = yield* tx.transact(
            deps.findById(DEP_1 as DependencyId),
          );
          expect(Option.isSome(after) && after.value.state).toBe("Satisfied");
        }
      }),
      makeP7App(),
    );
  });

  it("deliverables are immutable facts with artifact roles (No.49 binding)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const deliverables = yield* DeliverableRepository;
        yield* tx.transact(
          deliverables.insert(
            {
              deliverableId: DEL_1 as DeliverableId,
              sourceWorkId: WORK_1,
              sourceWorkRevision: 3,
              kind: "report",
            },
            [{ role: "summary", artifactId: "art_1" }],
            p7Project,
          ),
        );
        const found = yield* tx.transact(
          deliverables.findById(DEL_1 as DeliverableId),
        );
        expect(Option.isSome(found)).toBe(true);
        expect(Option.isSome(found) && found.value.sourceWorkRevision).toBe(3);
        const roles = yield* tx.transact(
          deliverables.listArtifactRoles(DEL_1 as DeliverableId),
        );
        expect(roles).toEqual(["summary"]);
        const duplicate = yield* tx
          .transact(
            deliverables.insert(
              {
                deliverableId: DEL_1 as DeliverableId,
                sourceWorkId: WORK_1,
                sourceWorkRevision: 4,
                kind: "report",
              },
              [],
              p7Project,
            ),
          )
          .pipe(Effect.flip);
        expect(duplicate._tag).toBe("DeliverableRepositoryFailure");
      }),
      makeP7App(),
    );
  });
});

void p7TestActor;
void p7TestPrincipal;
