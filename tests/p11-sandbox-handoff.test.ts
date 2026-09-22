import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import {
  SANDBOX_ENV_ALLOWLIST,
  sandboxEnvironment,
} from "../adapters/sandbox-local/src/index.js";
import {
  resolveSandboxWrite,
  SandboxWorktreeDeps,
  SandboxWorktreeLive,
  type SandboxWorktreeOptions,
  type SandboxWorktreeProvisionRequest,
  type SandboxWorktreeRetirement,
  type SandboxWriteBackChange,
  type WorktreeSandboxHandle,
} from "../adapters/sandbox-worktree/src/index.js";
import {
  type CanonicalResourceRegion,
  ExecutionId,
  type ProjectId,
  parse,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  SandboxPort,
  type SandboxPortService,
  TransactionPort,
  TransactionScope,
  type WorktreeRecord,
  WorktreeStore,
  type WorktreeStoreService,
} from "../packages/ports/src/index.js";

// P11 `12` (sandbox handoff): worktree-backed sandbox adapter on the FROZEN
// SandboxPort signature. All command mediation (CreateWorktree /
// RecordEnvironmentChange / RetireWorktree) is injected via deps callbacks
// (B3a/B3b/B3c); the adapter itself never touches raw git/fs worktree
// creation and never advances the environment anchor.

// --- fixed identities ---

const WS = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1");
const EXE = parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1");
const PROJECT =
  "prj_018f2b3c-4d5e-7abc-8def-0123456789a1" as never as ProjectId;

const suiteTmp = mkdtempSync(join(tmpdir(), "p11-sbx-handoff-"));
afterAll(() => {
  rmSync(suiteTmp, { recursive: true, force: true });
});

// --- fixtures ---

const gitWorktreeRegion = (path: string): CanonicalResourceRegion => ({
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "GitWorktree", path },
});

const worktreeRecord = (
  path: string,
  overrides: Partial<WorktreeRecord> = {},
): WorktreeRecord => ({
  worktreeId: "wt_0001",
  projectId: PROJECT,
  workspaceId: WS,
  address: { _tag: "GitWorktree", path },
  state: "Active",
  createdAt: "t0",
  ...overrides,
});

const seedFiles = (dir: string): void => {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "alpha");
  writeFileSync(join(dir, "src", "main.ts"), "export {};");
};

// --- fakes (record calls; production wiring belongs to the main session) ---

const WorktreeStoreFake = (
  records: ReadonlyArray<WorktreeRecord>,
): Layer.Layer<WorktreeStore> =>
  Layer.succeed(
    WorktreeStore,
    WorktreeStore.of({
      insert: () => Effect.void,
      findById: (worktreeId: string) => {
        const found = records.find((row) => row.worktreeId === worktreeId);
        return Effect.succeed(
          found === undefined ? Option.none() : Option.some(found),
        );
      },
      findByWorkspace: (workspaceId: WorkspaceId) =>
        Effect.succeed(
          records.filter((row) => row.workspaceId === workspaceId),
        ),
      retireIfActive: () => Effect.succeed(Option.none()),
    } as unknown as WorktreeStoreService),
  );

const TransactionPortFake: Layer.Layer<TransactionPort> = Layer.succeed(
  TransactionPort,
  TransactionPort.of({
    transact: (body) =>
      Effect.provideService(body, TransactionScope, {
        session: { id: "p11-sbx-handoff" },
      }),
  }),
);

interface DepsLog {
  readonly createWorktree: Array<SandboxWorktreeProvisionRequest>;
  readonly recordEnvironmentChange: Array<SandboxWriteBackChange>;
  readonly retireWorktree: Array<SandboxWorktreeRetirement>;
}

const emptyLog = (): DepsLog => ({
  createWorktree: [],
  recordEnvironmentChange: [],
  retireWorktree: [],
});

const SandboxWorktreeDepsFake = (
  log: DepsLog,
): Layer.Layer<SandboxWorktreeDeps> =>
  Layer.succeed(
    SandboxWorktreeDeps,
    SandboxWorktreeDeps.of({
      createWorktree: (request) =>
        Effect.sync(() => {
          log.createWorktree.push(request);
          // production wiring runs worktree-add through CreateWorktree; the
          // fake mirrors the materialized directory the command would yield
          mkdirSync(request.path, { recursive: true });
          writeFileSync(join(request.path, "provisioned.txt"), "from-wiring");
          return {
            worktreeId: `wt_sbx_${log.createWorktree.length}`,
            path: request.path,
          };
        }),
      recordEnvironmentChange: (change) =>
        Effect.sync(() => {
          log.recordEnvironmentChange.push(change);
        }),
      retireWorktree: (retirement) =>
        Effect.sync(() => {
          log.retireWorktree.push(retirement);
        }),
    }),
  );

const makeApp = (
  options: SandboxWorktreeOptions,
  records: ReadonlyArray<WorktreeRecord>,
  log: DepsLog,
): Layer.Layer<SandboxPort> =>
  Layer.provide(
    SandboxWorktreeLive({ baseDir: suiteTmp, ...options }),
    Layer.mergeAll(
      WorktreeStoreFake(records),
      TransactionPortFake,
      SandboxWorktreeDepsFake(log),
    ),
  );

const run = async <A, E>(
  program: (sandbox: SandboxPortService) => Effect.Effect<A, E>,
  options: SandboxWorktreeOptions = {},
  records: ReadonlyArray<WorktreeRecord> = [],
): Promise<{ result: A; log: DepsLog }> => {
  const log = emptyLog();
  const effect = Effect.gen(function* () {
    const sandbox = yield* SandboxPort;
    return yield* program(sandbox);
  });
  const result = await Effect.runPromise(
    Effect.scoped(Effect.provide(effect, makeApp(options, records, log))),
  );
  return { result, log };
};

// --- tests ---

describe("p11-sandbox-handoff", () => {
  it("open materializes an Active worktree's contents into the sandbox root (copy-on-open, P11 12 §1)", async () => {
    const worktreeDir = join(suiteTmp, "wt-copy");
    seedFiles(worktreeDir);
    const { result: handle } = await run(
      (sbx) =>
        sbx.open({
          executionId: EXE,
          workspaceId: WS,
          regions: [gitWorktreeRegion(worktreeDir)],
        }),
      {},
      [worktreeRecord(worktreeDir)],
    );
    expect(readFileSync(join(handle.rootPath, "a.txt"), "utf8")).toBe("alpha");
    expect(readFileSync(join(handle.rootPath, "src", "main.ts"), "utf8")).toBe(
      "export {};",
    );
    expect((handle as WorktreeSandboxHandle).metadata).toEqual({
      source: "worktree",
      worktreeId: "wt_0001",
    });
  });

  it("open without a matching worktree degrades to an empty root and close records nothing", async () => {
    const { log } = await run((sbx) =>
      Effect.gen(function* () {
        const handle = yield* sbx.open({
          executionId: EXE,
          workspaceId: WS,
          regions: [gitWorktreeRegion(join(suiteTmp, "absent-wt"))],
        });
        expect(existsSync(handle.rootPath)).toBe(true);
        expect(readdirSync(handle.rootPath)).toEqual([]);
        expect((handle as WorktreeSandboxHandle).metadata?.worktreeId).toBe(
          undefined,
        );
        yield* sbx.close(handle);
      }),
    );
    expect(log.createWorktree).toEqual([]);
    expect(log.recordEnvironmentChange).toEqual([]);
    expect(log.retireWorktree).toEqual([]);
  });

  it("provisionOnOpen routes new worktree needs through deps.createWorktree, never raw fs (B3a)", async () => {
    const fresh = join(suiteTmp, "fresh-wt");
    const { result: handle, log } = await run(
      (sbx) =>
        sbx.open({
          executionId: EXE,
          workspaceId: WS,
          regions: [gitWorktreeRegion(fresh)],
        }),
      { provisionOnOpen: true },
    );
    expect(log.createWorktree).toEqual([{ workspaceId: WS, path: fresh }]);
    expect(readFileSync(join(handle.rootPath, "provisioned.txt"), "utf8")).toBe(
      "from-wiring",
    );
    expect((handle as WorktreeSandboxHandle).metadata?.worktreeId).toBe(
      "wt_sbx_1",
    );
  });

  it("close writes back, emits a Governance-cause recordEnvironmentChange, and leaves pre-existing worktrees Active (B3b; close-releases)", async () => {
    const worktreeDir = join(suiteTmp, "wt-writeback");
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, "keep.txt"), "kept");
    const regions = [gitWorktreeRegion(worktreeDir)];
    const { log } = await run(
      (sbx) =>
        Effect.gen(function* () {
          const handle = yield* sbx.open({
            executionId: EXE,
            workspaceId: WS,
            regions,
          });
          writeFileSync(join(handle.rootPath, "out.txt"), "written-in-sandbox");
          yield* sbx.close(handle);
          expect(existsSync(handle.rootPath)).toBe(false);
        }),
      {},
      [worktreeRecord(worktreeDir)],
    );
    expect(readFileSync(join(worktreeDir, "out.txt"), "utf8")).toBe(
      "written-in-sandbox",
    );
    expect(readFileSync(join(worktreeDir, "keep.txt"), "utf8")).toBe("kept");
    expect(log.recordEnvironmentChange).toEqual([
      { workspaceId: WS, cause: "Governance", regions },
    ]);
    expect(log.retireWorktree).toEqual([]);
  });

  it("ephemeral retention (default) retires adapter-created worktrees at close (B3c)", async () => {
    const fresh = join(suiteTmp, "ephemeral-wt");
    const { log } = await run(
      (sbx) =>
        Effect.gen(function* () {
          const handle = yield* sbx.open({
            executionId: EXE,
            workspaceId: WS,
            regions: [gitWorktreeRegion(fresh)],
          });
          writeFileSync(join(handle.rootPath, "work.txt"), "done");
          yield* sbx.close(handle);
        }),
      { provisionOnOpen: true },
    );
    expect(readFileSync(join(fresh, "work.txt"), "utf8")).toBe("done");
    expect(log.recordEnvironmentChange[0]?.cause).toBe("Governance");
    expect(log.retireWorktree).toEqual([{ worktreeId: "wt_sbx_1" }]);
  });

  it("persistent retention keeps adapter-created worktrees Active at close (B3c / SD 11.4)", async () => {
    const { log } = await run(
      (sbx) =>
        Effect.gen(function* () {
          const handle = yield* sbx.open({
            executionId: EXE,
            workspaceId: WS,
            regions: [gitWorktreeRegion(join(suiteTmp, "persistent-wt"))],
          });
          yield* sbx.close(handle);
        }),
      { provisionOnOpen: true, retention: "persistent" },
    );
    expect(log.recordEnvironmentChange).toHaveLength(1);
    expect(log.retireWorktree).toEqual([]);
  });

  it("writes resolve only inside writableRegions — out-of-bounds resolve is rejected (P4 04 §3)", async () => {
    const worktreeDir = join(suiteTmp, "wt-resolve");
    mkdirSync(worktreeDir, { recursive: true });
    const { result: handle } = await run(
      (sbx) =>
        sbx.open({
          executionId: EXE,
          workspaceId: WS,
          regions: [gitWorktreeRegion(worktreeDir)],
        }),
      {},
      [worktreeRecord(worktreeDir)],
    );
    const inside = resolveSandboxWrite(
      handle,
      join(worktreeDir, "src", "a.ts"),
    );
    expect(inside._tag).toBe("Resolved");
    if (inside._tag === "Resolved") {
      expect(inside.sandboxPath).toBe(join(handle.rootPath, "src", "a.ts"));
    }
    expect(resolveSandboxWrite(handle, worktreeDir)._tag).toBe("Resolved");
    expect(resolveSandboxWrite(handle, "/elsewhere/x")).toEqual({
      _tag: "OutsideWritableRegions",
      path: "/elsewhere/x",
    });
  });

  it("close releases the sandbox root on the degraded (no worktree) path too", async () => {
    await run((sbx) =>
      Effect.gen(function* () {
        const handle = yield* sbx.open({
          executionId: EXE,
          workspaceId: WS,
          regions: [gitWorktreeRegion(join(suiteTmp, "release-wt"))],
        });
        expect(existsSync(handle.rootPath)).toBe(true);
        yield* sbx.close(handle);
        expect(existsSync(handle.rootPath)).toBe(false);
      }),
    );
  });

  it("sandbox-local projects the subprocess env onto the minimal allow-list (P4 04 §4 debt, repaid per P11 12 §2)", () => {
    const projected = sandboxEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
      LANG: "C.UTF-8",
      SECRET_TOKEN: "s3cret",
      ARBOR_CONTROL_DSN: "sqlite:control",
      NODE_OPTIONS: "--inspect",
    });
    expect(Object.keys(projected).sort()).toEqual(["HOME", "LANG", "PATH"]);
    expect(projected.PATH).toBe("/usr/bin:/bin");
    expect("SECRET_TOKEN" in projected).toBe(false);
    expect("ARBOR_CONTROL_DSN" in projected).toBe(false);
    expect("NODE_OPTIONS" in projected).toBe(false);
    expect(
      Object.keys(projected).every((key) =>
        SANDBOX_ENV_ALLOWLIST.includes(key),
      ),
    ).toBe(true);
  });
});
