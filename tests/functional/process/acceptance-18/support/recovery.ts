// Shared AH18 lease-expiry and fail-closed recovery helpers — moved verbatim
// from ah18-overflow-linked-compaction-resume.functional.test.ts (B5 split).
import { expect } from "vitest";
import { expireExecutionLeaseAfterOwnerExitForQualification } from "../../../support/lease-qualification.js";
import type { ProductionFixture } from "../../../support/production-fixture.js";
import { waitForPublic } from "../../../support/public-client.js";
import { readSnapshot } from "./snapshot.js";

export const expireLeaseAfterOldDaemonExit = (
  fixture: ProductionFixture,
  project: { readonly rootSessionId: string },
  executionId: string,
  workId: string,
) => {
  const lease = readSnapshot(fixture.databaseFile, {
    sessionId: project.rootSessionId,
    executionId,
    workId,
  }).leases.find((candidate) => candidate.execution_id === executionId);
  if (lease === undefined)
    throw new Error(`AH18 lease ${executionId} is absent after daemon exit`);
  return expireExecutionLeaseAfterOwnerExitForQualification({
    databaseFile: fixture.databaseFile,
    executionId,
    expected: {
      generation: Number(lease.generation),
      expiresAt: lease.expires_at,
    },
    daemon: {
      crash: fixture.crash,
      snapshot: fixture.daemonProcessSnapshot,
    },
  });
};

export const waitForFailedRestartExit = async (
  fixture: ProductionFixture,
): Promise<
  NonNullable<ReturnType<ProductionFixture["daemonProcessSnapshot"]>>
> => {
  const snapshot = await waitForPublic(
    async () => fixture.daemonProcessSnapshot(),
    (snapshot) =>
      snapshot !== null &&
      !snapshot.alive &&
      (snapshot.exitCode !== null || snapshot.signalCode !== null),
    15_000,
  );
  if (snapshot === null) {
    throw new Error("AH18 failed restart process snapshot is unavailable");
  }
  return snapshot;
};

export const expectFailClosedEvidence = (
  fixture: ProductionFixture,
  restartError: unknown,
) => {
  const evidence = `${fixture.daemonErrors.join(" | ")} ${restartError instanceof Error ? restartError.message : String(restartError ?? "")}`;
  expect(evidence).toMatch(
    /ProtocolViolation|manifest|context|ProviderRuntime|AgentLoopStep/iu,
  );
};
