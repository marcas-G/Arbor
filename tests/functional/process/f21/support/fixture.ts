// Shared F21 OPEN-3 activation recovery fixture helpers — moved verbatim from
// f21-open3-activation-recovery.functional.test.ts (B5 split).
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../../../support/production-fixture.js";
import {
  functionalId,
  makePublicClient,
} from "../../../support/public-client.js";

export const repositoryRoot = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
);
export const activationDaemonChild = join(
  repositoryRoot,
  "tests",
  "functional",
  "support",
  "f21-activation-daemon-child.mjs",
);

export const waitForMarker = async (markerFile: string) => {
  const startedAt = Date.now();
  while (!existsSync(markerFile)) {
    if (Date.now() - startedAt > 60_000) {
      throw new Error(
        `timed out waiting for P11 activation marker ${markerFile}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

export const makeEnvelope = async (fixture: ProductionFixture) => {
  const client = makePublicClient(fixture.baseUrl);
  const catalog = await client.projectResources();
  const profile = catalog.profiles.find((candidate) => candidate.available);
  expect(profile).toBeDefined();
  if (profile === undefined) throw new Error("host Profile was not listed");
  expect(JSON.stringify(catalog)).not.toContain(fixture.workspaceDirectory);

  const projectId = functionalId("prj");
  const workspaceId = functionalId("ws");
  const sessionId = functionalId("ses");
  const commandId = functionalId("cmd");
  return {
    client,
    projectId,
    workspaceId,
    sessionId,
    commandId,
    envelope: {
      commandType: "CreateProject",
      commandId,
      projectId,
      actor: "user:local",
      issuedAt: "2026-10-10T00:00:00.000Z",
      payload: {
        name: "F21 OPEN-3 activation process recovery",
        revision: 0,
        projectPolicy: { delegationCeiling: 1 },
        projectPolicyRevision: 0,
        defaultConfiguration: {},
        environmentRef: "local",
        rootWorkspaceId: workspaceId,
        primarySession: { sessionId, contextEpoch: 0 },
        rootWorkspace: {
          name: "root",
          responsibilityDefinition: {
            purpose: "F21 OPEN-3 activation process recovery",
            ownedResponsibilities: [],
            obligations: [],
            includes: [],
            excludes: [],
            interfaces: [],
          },
          responsibilityRevision: 0,
          resourceSelection: {
            _tag: "Profile",
            resourceProfileRef: profile.resourceProfileRef,
            version: profile.version,
          },
          agentBinding: {
            _tag: "ResponsibilityBoundAgentBinding",
            workspaceId,
          },
          workspacePolicy: { delegationCeiling: 1 },
          workspacePolicyRevision: 0,
          revision: 0,
        },
      },
    },
  };
};

export const withDatabase = <A>(
  fixture: ProductionFixture,
  run: (db: DatabaseSync) => A,
) => {
  const db = new DatabaseSync(fixture.databaseFile);
  try {
    return run(db);
  } finally {
    db.close();
  }
};

export const startProbedFixture = async (
  boundary:
    | "P11BeforeActivationCommit"
    | "P11AfterActivationCommit"
    | "GatewayCommittedBeforeP11Activation",
) => {
  const markerDirectory = mkdtempSync(join(tmpdir(), "arbor-f21-activation-"));
  const markerFile = join(markerDirectory, "activation.marker");
  const fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
    firstDaemonEntry: activationDaemonChild,
    daemonEnvironment: {
      F21_ACTIVATION_PROBE_BOUNDARY: boundary,
      F21_ACTIVATION_MARKER: markerFile,
    },
    reply: () => ({ _tag: "Text", text: "No model call expected" }),
  });
  return { fixture, markerDirectory, markerFile };
};
