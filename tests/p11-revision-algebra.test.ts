import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  EnvironmentRevisionStoreLive,
  layer,
  P8_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { ProjectId, parse } from "../packages/domain/dist/index.js";
import {
  EnvironmentFingerprint,
  EnvironmentRevision,
} from "../packages/domain/src/index.js";
import {
  EnvironmentRevisionStore,
  TransactionPort,
} from "../packages/ports/src/index.js";

const PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c1");
const PROJECT_B = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c2");

const storeLayer = () => {
  const base = layer({ filename: ":memory:" });
  const store = Layer.provide(
    EnvironmentRevisionStoreLive,
    Layer.merge(base, ClockLive),
  );
  const tx = Layer.provide(TransactionPortLive, base);
  return Layer.provideMerge(Layer.mergeAll(store, tx, base), base);
};

const run = <A, E>(
  program: Effect.Effect<
    A,
    E,
    SqlClient | EnvironmentRevisionStore | TransactionPort
  >,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        program as Effect.Effect<A, E, SqlClient | EnvironmentRevisionStore>,
        storeLayer(),
      ),
    ),
  );

const withStore = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  const sql = yield* SqlClient;
  const store = yield* EnvironmentRevisionStore;
  const tx = yield* TransactionPort;
  // minimal project rows (FK order: sessions(deferred) -> projects -> workspaces)
  yield* tx.transact(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,'WorkspacePrimary',?,NULL,0,'t')",
        ["ses_p11a", "ws_p11a"],
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,'WorkspacePrimary',?,NULL,0,'t')",
        ["ses_p11b", "ws_p11b"],
      );
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,'p',?,'{}',0,'{}','local','Open',0,'t','t')",
        [PROJECT, "ws_p11a"],
      );
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,'p',?,'{}',0,'{}','local','Open',0,'t','t')",
        [PROJECT_B, "ws_p11b"],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'root','{}',1,'{}',1,'{}',?,'{}',0,0,'Active','t','t')",
        ["ws_p11a", PROJECT, "ses_p11a"],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'root','{}',1,'{}',1,'{}',?,'{}',0,0,'Active','t','t')",
        ["ws_p11b", PROJECT_B, "ses_p11b"],
      );
    }),
  );
  return { store, tx };
});

void (async () => {
  // debug helper
})();

describe("P11-001 revision algebra (domain)", () => {
  it("initial revision is the counter '1' (P1-DG-08)", () => {
    expect(EnvironmentRevision.initial().value).toBe("1");
  });

  it("monotonic progression via next() only: 1 -> 2 -> 3", () => {
    const r1 = EnvironmentRevision.initial();
    const r2 = r1.next();
    const r3 = r2.next();
    expect([r1.value, r2.value, r3.value]).toEqual(["1", "2", "3"]);
    expect(EnvironmentRevision.compare(r1, r2)).toBe(-1);
    expect(EnvironmentRevision.compare(r3, r1)).toBe(1);
    expect(EnvironmentRevision.compare(r2, r2)).toBe(0);
  });

  it("fingerprint equality is independent of revision ordering", () => {
    const fpA1 = EnvironmentFingerprint.of("digest-A");
    const fpA2 = EnvironmentFingerprint.of("digest-A");
    const fpB = EnvironmentFingerprint.of("digest-B");
    expect(fpA1.equals(fpA2)).toBe(true);
    expect(fpA1.equals(fpB)).toBe(false);
    // Same fingerprint across different revisions — perfectly legal.
    const r1 = EnvironmentRevision.initial();
    const r2 = r1.next();
    expect(fpA1.equals(fpA2)).toBe(true);
    expect(EnvironmentRevision.equal(r1, r2)).toBe(false);
  });

  it("ABA: A -> B -> A still advances the counter (detected by progression, immune to fingerprint equality)", () => {
    const fpA = EnvironmentFingerprint.of("content-A");
    const fpB = EnvironmentFingerprint.of("content-B");
    const r1 = EnvironmentRevision.initial();
    const r2 = r1.next();
    const r3 = r2.next();
    expect(fpA.equals(EnvironmentFingerprint.of("content-A"))).toBe(true);
    expect(fpA.equals(fpB)).toBe(false);
    expect(EnvironmentRevision.compare(r1, r3)).toBe(-1);
  });

  it("fingerprint has NO ordering surface (structural: no compare/numeric view)", () => {
    const fp = EnvironmentFingerprint.of("x");
    const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(fp)).filter(
      (k) => k !== "constructor",
    );
    expect(keys).toEqual(["equals"]); // equality only — ordering cannot be expressed
  });

  it("parse validates the decimal counter; garbage is rejected", () => {
    expect(EnvironmentRevision.parse("1")?.value).toBe("1");
    expect(EnvironmentRevision.parse("42")?.value).toBe("42");
    expect(EnvironmentRevision.parse("0")).toBeNull();
    expect(EnvironmentRevision.parse("01")).toBeNull();
    expect(EnvironmentRevision.parse("-1")).toBeNull();
    expect(EnvironmentRevision.parse("abc")).toBeNull();
    expect(EnvironmentRevision.parse("1.5")).toBeNull();
    expect(EnvironmentRevision.parse("")).toBeNull();
  });
});

describe("P11-001 store (typed advancement authority)", () => {
  it("lazy-init anchor writes '1' once; a second call is a no-op", async () => {
    await run(
      Effect.gen(function* () {
        const { store, tx } = yield* withStore;
        const before = yield* tx.transact(store.current(PROJECT));
        expect(Option.isNone(before)).toBe(true);
        yield* tx.transact(store.lazyInitAnchor(PROJECT));
        const after = yield* tx.transact(store.current(PROJECT));
        expect(Option.isSome(after) && after.value).toBe("1");
        yield* tx.transact(store.lazyInitAnchor(PROJECT)); // no-op
        const again = yield* tx.transact(store.current(PROJECT));
        expect(Option.isSome(again) && again.value).toBe("1");
      }),
    );
  });

  it("advanceAnchor is a strict-successor CAS: 1 -> 2 -> 3, stale expected conflicts", async () => {
    await run(
      Effect.gen(function* () {
        const { store, tx } = yield* withStore;
        yield* tx.transact(store.lazyInitAnchor(PROJECT));
        const first = yield* tx.transact(store.advanceAnchor(PROJECT, "1"));
        expect(first).toEqual({ _tag: "Advanced", to: "2" });
        const stale = yield* tx.transact(store.advanceAnchor(PROJECT, "1"));
        expect(stale).toEqual({ _tag: "RevisionConflict", current: "2" });
        const second = yield* tx.transact(store.advanceAnchor(PROJECT, "2"));
        expect(second).toEqual({ _tag: "Advanced", to: "3" });
        const current = yield* tx.transact(store.current(PROJECT));
        expect(Option.isSome(current) && current.value).toBe("3");
      }),
    );
  });

  it("advanceAnchor on a missing anchor is typed, not a blind init", async () => {
    await run(
      Effect.gen(function* () {
        const { store, tx } = yield* withStore;
        const result = yield* tx.transact(store.advanceAnchor(PROJECT_B, "1"));
        expect(result._tag).toBe("AnchorMissing");
      }),
    );
  });

  it("counters are project-scoped (independent anchors)", async () => {
    await run(
      Effect.gen(function* () {
        const { store, tx } = yield* withStore;
        yield* tx.transact(store.lazyInitAnchor(PROJECT));
        yield* tx.transact(store.lazyInitAnchor(PROJECT_B));
        yield* tx.transact(store.advanceAnchor(PROJECT, "1"));
        const a = yield* tx.transact(store.current(PROJECT));
        const b = yield* tx.transact(store.current(PROJECT_B));
        expect(Option.isSome(a) && a.value).toBe("2");
        expect(Option.isSome(b) && b.value).toBe("1");
      }),
    );
  });

  it("persistence boundary: raw record stays the transport; parse round-trips stored counters", async () => {
    await run(
      Effect.gen(function* () {
        const { store, tx } = yield* withStore;
        yield* tx.transact(store.lazyInitAnchor(PROJECT));
        yield* tx.transact(store.advanceAnchor(PROJECT, "1"));
        const raw = yield* tx.transact(store.current(PROJECT));
        const parsed = EnvironmentRevision.parse(Option.getOrThrow(raw));
        expect(parsed?.value).toBe("2");
      }),
    );
  });
});

describe("P11-001 separation audit (no second interpretation in code)", () => {
  it("no ordering operation exists on fingerprints anywhere in domain exports", async () => {
    const domain = await import("../packages/domain/src/index.js");
    const exported = Object.keys(domain);
    expect(
      exported.filter((name) =>
        /fingerprint.*(compare|order|less|greater|before|after)/i.test(name),
      ),
    ).toEqual([]);
    expect(
      exported.filter((name) =>
        /compare.*fingerprint|order.*fingerprint/i.test(name),
      ),
    ).toEqual([]);
  });

  it("instances expose only next(); ordering/equality are class-level only", async () => {
    const instance = EnvironmentRevision.initial();
    const proto = Object.getOwnPropertyNames(
      Object.getPrototypeOf(instance),
    ).filter((k) => k !== "constructor");
    expect(proto).toEqual(["next"]);
    const statics = Object.getOwnPropertyNames(EnvironmentRevision).filter(
      (k) =>
        ![
          "length",
          "name",
          "prototype",
          "initial",
          "parse",
          "unsafeInitialFromStorage",
        ].includes(k),
    );
    expect(statics.sort()).toEqual(["compare", "equal"].sort());
  });
});
