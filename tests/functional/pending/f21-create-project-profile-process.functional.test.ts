import { expect, test } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import { functionalId, makePublicClient } from "../support/public-client.js";

let fixture: ProductionFixture;
const daemonOutput: string[] = [];

test.beforeAll(async () => {
  fixture = await startProductionFixture({
    isolatedPortHandshake: true,
    admitWorkspaceDirectory: true,
    reply: () => ({ _tag: "Text", text: "No model call expected" }),
    onDaemonStdout: (line) => daemonOutput.push(line),
  });
});

test.afterAll(async () => {
  await fixture.stop();
});

test("public CreateProject Profile receipt survives daemon restart without exposing or changing the host path", async () => {
  const baseUrlBeforeRestart = fixture.baseUrl;
  const client = makePublicClient(fixture.baseUrl);
  const catalog = await client.projectResources();
  const available = catalog.profiles.filter((profile) => profile.available);
  expect(available).toHaveLength(1);
  const profile = available[0];
  if (profile === undefined) throw new Error("host Profile was not listed");
  expect(JSON.stringify(catalog)).not.toContain(fixture.workspaceDirectory);

  const projectId = functionalId("prj");
  const workspaceId = functionalId("ws");
  const commandId = functionalId("cmd");
  const envelope = {
    commandType: "CreateProject",
    commandId,
    projectId,
    actor: "user:local",
    issuedAt: "2026-10-10T00:00:00.000Z",
    payload: {
      name: "F21 public Profile restart",
      revision: 0,
      projectPolicy: { delegationCeiling: 1 },
      projectPolicyRevision: 0,
      defaultConfiguration: {},
      environmentRef: "local",
      rootWorkspaceId: workspaceId,
      primarySession: {
        sessionId: functionalId("ses"),
        contextEpoch: 0,
      },
      rootWorkspace: {
        name: "root",
        responsibilityDefinition: {
          purpose: "F21 public Profile restart",
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
  };
  const send = async () => {
    const response = await fetch(`${fixture.baseUrl}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    return { status: response.status, body: await response.json() };
  };

  const first = await send();
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({
    ok: true,
    body: { commandId, resolution: "Committed" },
  });
  expect(JSON.stringify(first.body)).not.toContain(fixture.workspaceDirectory);

  // restart waits for the first child to exit before rebinding this URL under
  // a fresh daemon process identity.
  await fixture.restart();
  expect(fixture.baseUrl).toBe(baseUrlBeforeRestart);
  const afterRestartCatalog = await client.projectResources();
  expect(afterRestartCatalog).toEqual(catalog);
  const replay = await send();
  expect(replay.status).toBe(200);
  expect(replay.body).toMatchObject({
    ok: true,
    body: { commandId, resolution: "Committed" },
  });
  expect(JSON.stringify(replay.body)).not.toContain(fixture.workspaceDirectory);
  const startupReports = daemonOutput
    .map((line) => {
      try {
        return JSON.parse(line) as {
          readonly tag?: string;
          readonly nonce?: string;
          readonly pid?: number;
          readonly port?: number;
        };
      } catch {
        return undefined;
      }
    })
    .filter(
      (report) =>
        report?.tag === "FUNCTIONAL_DAEMON_STARTED" ||
        report?.tag === "FUNCTIONAL_DAEMON_LISTENING",
    );
  const started = startupReports.filter(
    (report) => report?.tag === "FUNCTIONAL_DAEMON_STARTED",
  );
  const listening = startupReports.filter(
    (report) => report?.tag === "FUNCTIONAL_DAEMON_LISTENING",
  );
  expect(started).toHaveLength(2);
  expect(listening).toHaveLength(2);
  expect(started[1]?.nonce).not.toBe(started[0]?.nonce);
  expect(started[1]?.pid).not.toBe(started[0]?.pid);
  expect(listening.map((report) => report?.nonce)).toEqual(
    started.map((report) => report?.nonce),
  );
  expect(listening.map((report) => report?.pid)).toEqual(
    started.map((report) => report?.pid),
  );
  expect(listening.map((report) => report?.port)).toEqual([
    Number(new URL(baseUrlBeforeRestart).port),
    Number(new URL(baseUrlBeforeRestart).port),
  ]);
  expect(fixture.daemonErrors).toEqual([]);
  expect(fixture.providerCalls).toHaveLength(0);
});
