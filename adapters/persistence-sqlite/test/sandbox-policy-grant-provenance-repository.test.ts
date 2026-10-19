import { DatabaseSync } from "node:sqlite";
import {
  CommandId,
  PermissionGrantId,
  Principal,
  ProjectId,
  parse,
} from "@arbor/domain";
import { PermissionGrantRepository, TransactionPort } from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { createSchema48TestDatabase } from "../../../tests/support/schema44-database.js";
import {
  layer,
  P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION,
  P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION,
  runMigrations,
} from "../src/index.js";
import { PermissionGrantRepositoryLive } from "../src/permission-grant-repository.js";
import { TransactionPortLive } from "../src/transaction.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const permissionGrantId = parse(PermissionGrantId)(
  "pgr_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const grantCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

describe("PermissionGrantRepository sandbox issuer provenance", () => {
  it("round-trips the exact immutable provenance in a disposable schema-50 database", async () => {
    const fixture = await createSchema48TestDatabase();
    try {
      const seed = new DatabaseSync(fixture.databaseFilename);
      try {
        seed.exec("PRAGMA foreign_keys = OFF");
        seed
          .prepare(
            `INSERT INTO commands (
              command_id, project_id, semantic_request_fingerprint,
              schema_version, fingerprint_algorithm_version, resolution,
              result_json, terminal_error_json, created_at, settled_at
            ) VALUES (?, ?, ?, ?, ?, 'Committed', ?, NULL, ?, ?)`,
          )
          .run(
            grantCommandId,
            projectId,
            "f".repeat(64),
            "GrantPermission/1",
            1,
            JSON.stringify({ permissionGrantId, state: "Active" }),
            "2026-10-19T00:00:00.000Z",
            "2026-10-19T00:00:00.000Z",
          );
        seed
          .prepare(
            `INSERT INTO permission_grants (
              permission_grant_id, project_id, scope, issuer, lifetime, state,
              subject_kind, subject_ref, capability, target, valid_from,
              expires_at, revision
            ) VALUES (?, ?, ?, ?, ?, 'Active', 'HumanPrincipal', ?, ?, ?, ?, ?, 0)`,
          )
          .run(
            permissionGrantId,
            projectId,
            `DecideSandboxPolicy@exe_018f2b3c-4d5e-7abc-8def-0123456789a1`,
            "user:operator",
            "PT1H",
            "user:subject",
            "DecideSandboxPolicy",
            "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
            "2026-10-19T00:00:00.000Z",
            "2026-10-19T01:00:00.000Z",
          );
      } finally {
        seed.close();
      }

      const base = layer({ filename: fixture.databaseFilename });
      const app = Layer.mergeAll(
        base,
        Layer.provide(TransactionPortLive, base),
        Layer.provide(PermissionGrantRepositoryLive, base),
      );
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(
              [
                P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION,
                P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION,
              ],
              { allowOfflineOnly: true },
            );
            const transactions = yield* TransactionPort;
            const grants = yield* PermissionGrantRepository;
            const grant = yield* transactions.transact(
              grants.findById(permissionGrantId),
            );
            expect(Option.isSome(grant)).toBe(true);
            const provenance = {
              permissionGrantId,
              grantPermissionCommandId: grantCommandId,
              issuerPrincipal: parse(Principal)("user:operator"),
              operatorConfigRevision: 4,
              operatorConfigDigest: "a".repeat(64),
            };
            yield* transactions.transact(
              grants.insertSandboxPolicyGrantIssuerProvenance(provenance),
            );
            expect(
              Option.getOrNull(
                yield* transactions.transact(
                  grants.findSandboxPolicyGrantIssuerProvenanceByGrantId(
                    permissionGrantId,
                  ),
                ),
              ),
            ).toEqual(provenance);
          }),
          app,
        ),
      );
    } finally {
      fixture.cleanup();
    }
  });
});
