import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  join,
  relative as relativePath,
  resolve as resolvePath,
} from "node:path";
import type { CanonicalResourceRegion, WorkspaceId } from "@arbor/domain";
import {
  type SandboxError,
  type SandboxHandle,
  SandboxPort,
  TransactionPort,
  type WorktreeRecord,
  WorktreeStore,
} from "@arbor/ports";
import { Context, Effect, Layer } from "effect";

/**
 * P11 `12` (P4 `04` frozen SandboxPort + guarantees): the worktree-backed
 * sandbox adapter. `SandboxPort`/`SandboxHandle` signatures are UNCHANGED —
 * advanced isolation is a new adapter, and the handle's optional metadata
 * below is additive only.
 *
 * B3 wiring (CI-1/CI-3/CI-4): every command mediation (CreateWorktree,
 * RecordEnvironmentChange, RetireWorktree) is an INJECTED callback. The
 * adapter never creates worktrees with raw fs/git, never advances the
 * environment anchor, and never uses ExternalDrift for its own write-back.
 */

// --- additive handle metadata (P11 12 §1) ---

export interface SandboxWorktreeMetadata {
  readonly source: "worktree";
  readonly worktreeId?: string;
}

export interface WorktreeSandboxHandle extends SandboxHandle {
  readonly metadata?: SandboxWorktreeMetadata;
}

// --- options ---

export type WorktreeRetentionPolicy = "ephemeral" | "persistent";

export interface SandboxWorktreeOptions {
  /** Parent directory for sandbox roots (os.tmpdir() by default). */
  readonly baseDir?: string;
  /** Terminal path for adapter-created worktrees at close (B3c/CI-3,
   * SD §11.4). Default "ephemeral". */
  readonly retention?: WorktreeRetentionPolicy;
  /** When true, a writable region with no matching Active worktree is
   * provisioned through deps.createWorktree (B3a); when false (default),
   * open degrades to an empty root for that region. */
  readonly provisionOnOpen?: boolean;
}

// --- deps (production wiring belongs to the main session) ---

export interface SandboxWorktreeProvisionRequest {
  readonly workspaceId: WorkspaceId;
  readonly path: string;
}

export interface SandboxWorktreeProvision {
  readonly worktreeId: string;
  readonly path: string;
}

/** B3b: the close-time write-back change — cause is fixed to "Governance"
 * (an Arbor-originated mutation is never recorded as ExternalDrift). */
export interface SandboxWriteBackChange {
  readonly workspaceId: WorkspaceId;
  readonly cause: "Governance";
  readonly regions: ReadonlyArray<CanonicalResourceRegion>;
}

export interface SandboxWorktreeRetirement {
  readonly worktreeId: string;
}

/** P12 `01` §7 (G8/DF-16): adapter-local opaque command rejection. The
 * injected command mediation's rejection is only forwarded, never
 * interpreted here; declaring it locally removes the `application` edge
 * (DID §10.4.1: `adapters/* -> domain, ports`). Any command rejection with a
 * `_tag` structurally satisfies it. */
export interface SandboxWorktreeCommandRejection {
  readonly _tag: string;
}

export type SandboxWorktreeDepsError =
  | {
      readonly _tag: "CreateWorktreeFailed";
      readonly rejection: SandboxWorktreeCommandRejection;
    }
  | {
      readonly _tag: "RecordEnvironmentChangeFailed";
      readonly cause: unknown;
    }
  | {
      readonly _tag: "RetireWorktreeFailed";
      readonly rejection: SandboxWorktreeCommandRejection;
    };

export interface SandboxWorktreeDepsService {
  readonly createWorktree: (
    request: SandboxWorktreeProvisionRequest,
  ) => Effect.Effect<SandboxWorktreeProvision, SandboxWorktreeDepsError>;
  readonly recordEnvironmentChange: (
    change: SandboxWriteBackChange,
  ) => Effect.Effect<void, SandboxWorktreeDepsError>;
  readonly retireWorktree: (
    retirement: SandboxWorktreeRetirement,
  ) => Effect.Effect<void, SandboxWorktreeDepsError>;
}

export class SandboxWorktreeDeps extends Context.Service<
  SandboxWorktreeDeps,
  SandboxWorktreeDepsService
>()("arbor/SandboxWorktreeDeps") {}

// --- write confinement (P4 04 §3: writes confined to writableRegions) ---

export type SandboxWriteResolution =
  | {
      readonly _tag: "Resolved";
      readonly region: CanonicalResourceRegion;
      readonly sandboxPath: string;
    }
  | {
      readonly _tag: "OutsideWritableRegions";
      readonly path: string;
    };

const pathOfRegion = (region: CanonicalResourceRegion): string | undefined => {
  if (
    typeof region.normalizedRegion !== "object" ||
    region.normalizedRegion === null
  ) {
    return undefined;
  }
  const normalized = region.normalizedRegion as {
    readonly kind?: unknown;
    readonly path?: unknown;
  };
  if (normalized.kind !== "GitWorktree" && normalized.kind !== "FileTree") {
    return undefined;
  }
  return typeof normalized.path === "string" ? normalized.path : undefined;
};

const coversPath = (regionPath: string, target: string): boolean =>
  target === regionPath || target.startsWith(`${regionPath}/`);

/** Resolve a canonical write target against a handle: the target must fall
 * inside a writable region (deepest region wins; the region is mounted at
 * the sandbox root — the copy-on-open mirror position), otherwise the
 * resolution is rejected as outside the writable regions. */
export const resolveSandboxWrite = (
  handle: SandboxHandle,
  targetPath: string,
): SandboxWriteResolution => {
  const target = resolvePath(targetPath);
  let best: { region: CanonicalResourceRegion; path: string } | undefined;
  for (const region of handle.writableRegions) {
    const regionPath = pathOfRegion(region);
    if (regionPath === undefined || !coversPath(regionPath, target)) {
      continue;
    }
    if (best === undefined || regionPath.length > best.path.length) {
      best = { region, path: regionPath };
    }
  }
  if (best === undefined) {
    return { _tag: "OutsideWritableRegions", path: targetPath };
  }
  const offset = relativePath(best.path, target);
  return {
    _tag: "Resolved",
    region: best.region,
    sandboxPath:
      offset === "" ? handle.rootPath : join(handle.rootPath, offset),
  };
};

// --- adapter internals ---

interface BackingWorktree {
  readonly worktreeId: string;
  readonly path: string;
  readonly adapterCreated: boolean;
}

interface OpenSandboxState {
  readonly rootPath: string;
  readonly workspaceId: WorkspaceId;
  readonly regions: ReadonlyArray<CanonicalResourceRegion>;
  readonly retention: WorktreeRetentionPolicy;
  readonly backing: ReadonlyArray<BackingWorktree>;
}

const sandboxFailure = (cause: unknown): SandboxError => ({
  _tag: "SandboxError",
  cause,
});

const attempt = <A>(thunk: () => A): Effect.Effect<A, SandboxError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(thunk());
    } catch (cause) {
      return Effect.fail(sandboxFailure(cause));
    }
  });

const worktreeRegionPath = (
  region: CanonicalResourceRegion,
): string | undefined => {
  if (
    typeof region.normalizedRegion !== "object" ||
    region.normalizedRegion === null
  ) {
    return undefined;
  }
  const normalized = region.normalizedRegion as {
    readonly kind?: unknown;
    readonly path?: unknown;
  };
  if (normalized.kind !== "GitWorktree") {
    return undefined;
  }
  return typeof normalized.path === "string" ? normalized.path : undefined;
};

const materializeIntoRoot = (worktreePath: string, rootPath: string): void => {
  if (existsSync(worktreePath)) {
    cpSync(worktreePath, rootPath, { recursive: true });
  }
};

export const SandboxWorktreeLive = (
  options: SandboxWorktreeOptions = {},
): Layer.Layer<
  SandboxPort,
  never,
  WorktreeStore | TransactionPort | SandboxWorktreeDeps
> =>
  Layer.effect(
    SandboxPort,
    Effect.gen(function* () {
      const worktrees = yield* WorktreeStore;
      const tx = yield* TransactionPort;
      const deps = yield* SandboxWorktreeDeps;
      const retention: WorktreeRetentionPolicy =
        options.retention ?? "ephemeral";
      const states = new Map<string, OpenSandboxState>();

      return SandboxPort.of({
        open: (input) =>
          Effect.gen(function* () {
            const records = yield* Effect.mapError(
              tx.transact(worktrees.findByWorkspace(input.workspaceId)),
              sandboxFailure,
            );
            const active = records.filter(
              (record: WorktreeRecord) => record.state === "Active",
            );
            const backing: Array<BackingWorktree> = [];
            for (const region of input.regions) {
              const regionPath = worktreeRegionPath(region);
              if (regionPath === undefined) {
                continue;
              }
              const matched = active.find((record: WorktreeRecord) =>
                coversPath(record.address.path, regionPath),
              );
              if (matched !== undefined) {
                if (
                  !backing.some(
                    (entry) => entry.worktreeId === matched.worktreeId,
                  )
                ) {
                  backing.push({
                    worktreeId: matched.worktreeId,
                    path: matched.address.path,
                    adapterCreated: false,
                  });
                }
                continue;
              }
              if (options.provisionOnOpen === true) {
                const provisioned = yield* Effect.mapError(
                  deps.createWorktree({
                    workspaceId: input.workspaceId,
                    path: regionPath,
                  }),
                  sandboxFailure,
                );
                backing.push({
                  worktreeId: provisioned.worktreeId,
                  path: provisioned.path,
                  adapterCreated: true,
                });
              }
            }
            const handleId = `sbx_${input.executionId}`;
            const rootPath = yield* attempt(() =>
              mkdtempSync(join(options.baseDir ?? tmpdir(), "arbor-wt-sbx-")),
            );
            for (const entry of backing) {
              yield* attempt(() => materializeIntoRoot(entry.path, rootPath));
            }
            states.set(handleId, {
              rootPath,
              workspaceId: input.workspaceId,
              regions: input.regions,
              retention,
              backing,
            });
            const sole = backing.length === 1 ? backing[0] : undefined;
            const metadata: SandboxWorktreeMetadata =
              sole !== undefined
                ? { source: "worktree", worktreeId: sole.worktreeId }
                : { source: "worktree" };
            const handle: WorktreeSandboxHandle = {
              handleId,
              rootPath,
              writableRegions: input.regions,
              metadata,
            };
            return handle;
          }),
        close: (handle) =>
          Effect.gen(function* () {
            const state = states.get(handle.handleId);
            if (state === undefined) {
              return;
            }
            states.delete(handle.handleId);
            if (state.backing.length > 0) {
              yield* attempt(() => {
                for (const entry of state.backing) {
                  mkdirSync(entry.path, { recursive: true });
                  cpSync(state.rootPath, entry.path, { recursive: true });
                }
              });
              yield* Effect.mapError(
                deps.recordEnvironmentChange({
                  workspaceId: state.workspaceId,
                  cause: "Governance",
                  regions: state.regions,
                }),
                sandboxFailure,
              );
              if (state.retention === "ephemeral") {
                for (const entry of state.backing) {
                  if (entry.adapterCreated) {
                    yield* Effect.mapError(
                      deps.retireWorktree({
                        worktreeId: entry.worktreeId,
                      }),
                      sandboxFailure,
                    );
                  }
                }
              }
            }
            yield* attempt(() =>
              rmSync(state.rootPath, { recursive: true, force: true }),
            );
          }),
      });
    }),
  );
