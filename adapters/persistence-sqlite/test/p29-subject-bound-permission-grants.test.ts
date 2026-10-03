import {
  PermissionGrantId,
  ProjectId,
  parse,
  WorkspaceId,
} from "@arbor/domain";
import { PermissionGrantRepository, TransactionPort } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { P28_MIGRATIONS, P29_MIGRATIONS } from "../src/migrations.js";
import { PermissionGrantRepositoryLive } from "../src/permission-grant-repository.js";
import { TransactionPortLive } from "../src/transaction.js";

describe("CAPA migration 0029 subject-bound PermissionGrant", () => {
  it("revokes legacy unbound grants and round-trips a bound grant", async () => {
    const base = layer({ filename: ":memory:" });
    const app = Layer.mergeAll(
      base,
      Layer.provide(TransactionPortLive, base),
      Layer.provide(PermissionGrantRepositoryLive, base),
    );
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P28_MIGRATIONS);
          const sql = yield* SqlClient;
          yield* sql.unsafe(
            "INSERT INTO permission_grants (permission_grant_id, project_id, scope, issuer, lifetime, state) VALUES ('pgr_legacy','prj_test','AssignWork','user:admin','PT1H','Active')",
          );
          yield* runMigrations(P29_MIGRATIONS);

          const legacy = yield* sql.unsafe<{ state: string }>(
            "SELECT state FROM permission_grants WHERE permission_grant_id = 'pgr_legacy'",
          );
          expect(legacy[0]?.state).toBe("Revoked");

          const projectId = parse(ProjectId)(
            "prj_018f2b3c-4d5e-7abc-8def-0123456789a1",
          );
          const workspaceId = parse(WorkspaceId)(
            "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
          );
          const grants = yield* PermissionGrantRepository;
          const tx = yield* TransactionPort;
          yield* tx.transact(
            grants.put(
              {
                permissionGrantId: parse(PermissionGrantId)(
                  "pgr_018f2b3c-4d5e-7abc-8def-0123456789a1",
                ),
                scope: `AssignWork@${workspaceId}`,
                issuer: "user:admin" as never,
                lifetime: "until-revoked",
                subject: { _tag: "WorkspaceAgent", workspaceId },
                capability: "AssignWork",
                target: workspaceId,
                validFrom: "2026-10-03T00:00:00.000Z",
                expiresAt: null,
                revision: 0,
                state: "Active",
              },
              projectId,
            ),
          );
          const active = yield* tx.transact(grants.activeGrants(projectId));
          expect(active).toHaveLength(1);
          expect(active[0]).toMatchObject({
            subject: { _tag: "WorkspaceAgent", workspaceId },
            capability: "AssignWork",
            target: workspaceId,
            validFrom: "2026-10-03T00:00:00.000Z",
            expiresAt: null,
            revision: 0,
          });
        }),
        app,
      ),
    );
  });
});
