import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  layer,
  P29_MIGRATIONS,
  PermissionGrantRepositoryLive,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  AuthorityResolverPort,
  AuthorityResolverPortLive,
} from "../packages/application/src/index.js";
import {
  ExecutionId,
  grantPermission,
  makeWorkspacePolicy,
  PermissionGrantId,
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  PermissionGrantRepository,
  TransactionPort,
} from "../packages/ports/src/index.js";

describe("Workspace permission durable lifetime", () => {
  it("retains explicit Workspace permission across reopening and new executions, denies another Workspace, and respects revocation", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "arbor-workspace-permission-"),
    );
    const filename = join(directory, "permission.db");
    const uuid = "018f2b3c-4d5e-7abc-8def-0123456789a1";
    const projectId = parse(ProjectId)(`prj_${uuid}`);
    const workspaceId = parse(WorkspaceId)(`ws_${uuid}`);
    const permissionGrantId = parse(PermissionGrantId)(`pgr_${uuid}`);
    const open = () => {
      const base = layer({ filename });
      return Layer.mergeAll(
        base,
        Layer.provide(TransactionPortLive, base),
        Layer.provide(PermissionGrantRepositoryLive, base),
        AuthorityResolverPortLive,
      );
    };
    try {
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(P29_MIGRATIONS);
            const grant = grantPermission({
              permissionGrantId,
              scope: `fs:write@${workspaceId}`,
              issuer: parse(Principal)("user:local"),
              lifetime: "Workspace",
              subject: { _tag: "WorkspaceAgent", workspaceId },
              capability: "fs:write",
              target: workspaceId,
              validFrom: "2026-11-16T00:00:00Z",
              expiresAt: null,
              revision: 0,
            });
            if (!grant.ok) throw new Error("persistent permission rejected");
            const tx = yield* TransactionPort;
            const grants = yield* PermissionGrantRepository;
            yield* tx.transact(grants.put(grant.value, projectId));
          }),
          open(),
        ),
      );

      // A different Layer creates a fresh SQLite connection after the first closes.
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            const grants = yield* PermissionGrantRepository;
            const resolver = yield* AuthorityResolverPort;
            const stored = yield* tx.transact(grants.activeGrants(projectId));
            expect(stored).toMatchObject([
              { expiresAt: null, lifetime: "Workspace" },
            ]);
            const invocation = (
              executionId: string,
              targetWorkspaceId = workspaceId,
            ) => ({
              principal: parse(Principal)("agent:worker"),
              projectId,
              workspaceId: targetWorkspaceId,
              executionId: parse(ExecutionId)(executionId),
              intent: {
                toolName: "write",
                toolVersion: "1",
                argumentsJson: "{}",
                actionDigest: "a".repeat(64),
                requestedCapabilities: ["fs:write"],
                resolvedRegions: ["project-tree"],
              },
              controlBasisDigest: "b".repeat(64),
              grants: stored,
              governance: { authenticatedHumans: [], directParentOf: [] },
              policy: makeWorkspacePolicy(),
              delegationDepth: 0,
              now: "2036-11-16T00:00:00Z",
            });
            for (const suffix of ["1", "2"]) {
              expect(
                (yield* resolver.resolveInvocation(
                  invocation(`exe_${uuid.slice(0, -1)}${suffix}`),
                )).allowedCapabilities,
              ).toEqual(["fs:write"]);
            }
            const wrongWorkspace = parse(WorkspaceId)(
              `ws_${uuid.slice(0, -1)}2`,
            );
            expect(
              (yield* Effect.result(
                resolver.resolveInvocation(
                  invocation(`exe_${uuid}`, wrongWorkspace),
                ),
              ))._tag,
            ).toBe("Failure");
            yield* tx.transact(grants.revoke(permissionGrantId));
            const remaining = yield* tx.transact(
              grants.activeGrants(projectId),
            );
            expect(remaining).toHaveLength(0);
            expect(
              (yield* Effect.result(
                resolver.resolveInvocation({
                  ...invocation(`exe_${uuid}`),
                  grants: remaining,
                }),
              ))._tag,
            ).toBe("Failure");
          }),
          open(),
        ),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
