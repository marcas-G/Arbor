import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSandboxPolicyPendingAction } from "../../../tests/functional/support/sandbox-policy-pending-action-fixture.js";
import { createSchema50TestDatabaseFactory } from "../../../tests/support/schema44-database.js";

let factory: Awaited<ReturnType<typeof createSchema50TestDatabaseFactory>>;

beforeAll(async () => {
  factory = await createSchema50TestDatabaseFactory({
    prefix: ".sandbox-policy-pending-action-fixture-",
  });
}, 300_000);

afterAll(() => factory?.cleanup(), 120_000);

describe("schema-50 production P3/P4 sandbox-policy fixture", () => {
  it("constructs a read-back-proven Pending action with a bound NotAdmitted invocation", async () => {
    const database = factory.create();
    try {
      const result = await seedSandboxPolicyPendingAction({
        databaseFilename: database.databaseFilename,
        primaryWorktreePath: database.directory,
      });
      expect(result.execution).toMatch(/^exe_/u);
      expect(result.recoveryBindingDigest).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      database.cleanup();
    }
  });
});
