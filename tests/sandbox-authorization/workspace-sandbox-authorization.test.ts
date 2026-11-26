import { describe, it } from "vitest";
import {
  acceptsCreateProjectV2Receipt,
  allocatesOnlyToDirectChild,
  commitsExactReceiptAndReplays,
  refusesMutationOfRetainedFacts,
  rejectsAnonymousHumanAuthority,
  rejectsWiderChildCapability,
  reportsCorruptExactReceipt,
  rereadsRevisionsInsideTransaction,
  retainsHumanChildRevocation,
  returnsTypedAppendConflict,
  rollsBackFactWhenDeferredReceiptAbsent,
  routesModelAllocationThroughGateway,
  serializesCompetingHeadReplacements,
} from "./phases-gateway-sqlite.js";
import { atomicallyCommitsAndReplaysV3Policy } from "./phases-policy-binding.js";
import {
  preservesLegacyDecisions,
  rollsBackRebuildOnBrokenForeignKeys,
} from "./phases-schema57-migration.js";
import { retainsAuthorizationAcrossReopenings } from "./phases-submission.js";
import {
  blocksWritesAfterReadOnlyOrRevocation,
  rejectsStaleShellAuthority,
  workspaceBaselineAsAgentAuthority,
} from "./phases-tool-admission.js";

describe("Workspace sandbox authorization Gateway and SQLite", () => {
  it("routes model allocation through Gateway and replays its receipt after Child revocation/ref changes without restoring authority", async () => {
    await routesModelAllocationThroughGateway();
  });

  it("retains a human Child revocation across reopening and Parent reallocation, until a human authorizes it again", async () => {
    await retainsHumanChildRevocation();
  });

  it("returns a typed append conflict without replacing a current head", async () => {
    await returnsTypedAppendConflict();
  });

  it("commits exact receipt/event/fact, replays without a new revision, reopens and remains valid across tasks", async () => {
    await commitsExactReceiptAndReplays();
  });

  it("accepts the exact CreateProject v2 receipt that initialized the Workspace authorization", async () => {
    await acceptsCreateProjectV2Receipt();
  });

  it("allocates only explicitly to the direct Child, survives Parent execution settlement, and stops after Parent revocation", async () => {
    await allocatesOnlyToDirectChild();
  });

  it("rejects anonymous human authority and current-Workspace allocation pretending to be direct Parent", async () => {
    await rejectsAnonymousHumanAuthority();
  });

  it("rereads Parent source and target resource revisions inside the Gateway transaction", async () => {
    await rereadsRevisionsInsideTransaction();
  });

  it("rejects wider Child capability and fenced Parent writes", async () => {
    await rejectsWiderChildCapability();
  });

  it("serializes competing current-head replacements across independent SQLite connections", async () => {
    await serializesCompetingHeadReplacements();
  });

  it("refuses mutation and deletion of retained facts and rejects corruption of the exact receipt", async () => {
    await refusesMutationOfRetainedFacts();
  });

  it("rolls back the fact when its deferred receipt is absent", async () => {
    await rollsBackFactWhenDeferredReceiptAbsent();
  });

  it.each([
    "schema_version='unknown'",
    "fingerprint_algorithm_version=2",
    "project_id='foreign-project'",
    "resolution='TerminalRejected',terminal_error_json='{}',result_json=NULL",
    "result_json=json_set(result_json,'$.extra',1)",
  ])(
    "reports a corrupt exact receipt rather than falling back: %s",
    async (patch) => {
      await reportsCorruptExactReceipt(patch);
    },
  );
});

describe("staged schema57 provenance migration", () => {
  it("preserves populated legacy decisions, exact receipt bytes and inbound fact foreign keys", async () => {
    await preservesLegacyDecisions();
  });

  it("rolls back the entire rebuild and schema version when existing foreign keys are broken", async () => {
    await rollsBackRebuildOnBrokenForeignKeys();
  });
});

describe("staged Workspace policy Gateway integration", () => {
  it("atomically commits and replays a V3 policy, and denies an already-resolved request after human revocation", async () => {
    await atomicallyCommitsAndReplaysV3Policy();
  });
});

describe("ordinary Workspace authorization submission", () => {
  it("uses one real local human and retains authorization/revocation across production Layer reopenings", async () => {
    await retainsAuthorizationAcrossReopenings();
  }, 120_000);
});

describe("Workspace authorization at tool effect admission", () => {
  it("uses the current Workspace baseline as agent fs:write and shell:exec authority", async () => {
    await workspaceBaselineAsAgentAuthority();
  });

  it("keeps reads available but blocks writes after ReadOnly or user revocation, including a previously resolved write", async () => {
    await blocksWritesAfterReadOnlyOrRevocation();
  });

  it("rejects stale shell authority after an intervening network restriction and denies a Child after Parent revocation", async () => {
    await rejectsStaleShellAuthority();
  });
});
