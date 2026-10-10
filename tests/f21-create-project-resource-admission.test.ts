import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  runMigrations,
  type SingleWorkspaceServices,
} from "../apps/single-workspace/src/composition.js";
import {
  type HostProjectResourceProfileConfig,
  makeProjectResourceProfilePort,
} from "../apps/single-workspace/src/project-resource-profiles.js";
import { externalContext } from "../apps/single-workspace/src/transport/auth.js";
import { makeExternalSubmissionFromServices } from "../apps/single-workspace/src/transport/composition.js";
import {
  type CreateProjectPayload,
  semanticRequestFingerprint,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  ContextEpochNumber,
  makeProjectPolicy,
  makeWorkspacePolicy,
  Principal,
  ProjectId,
  parse,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  CommandStore,
  ResourceOwnershipRepository,
  TransactionPort,
  WorkspaceRepository,
} from "../packages/ports/src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "arbor-f21-create-project-"));
  roots.push(root);
  return root;
};

const HUMAN = parse(Principal)("user:test");
const ACTOR = parse(Actor)("user:test");
const issuedAt = "2026-10-10T00:00:00.000Z";

interface RequestIds {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly commandId: CommandId;
}

const ids = (suffix: string): RequestIds => ({
  projectId: parse(ProjectId)(
    `prj_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`,
  ),
  workspaceId: parse(WorkspaceId)(
    `ws_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`,
  ),
  sessionId: parse(SessionId)(
    `ses_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`,
  ),
  commandId: parse(CommandId)(
    `cmd_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`,
  ),
});

const definition = {
  purpose: "F21 resource admission",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};

const payload = (
  request: RequestIds,
  resourceSelection: CreateProjectPayload["rootWorkspace"]["resourceSelection"],
): CreateProjectPayload => ({
  name: "F21 resource project",
  revision: parse(Revision)(0),
  projectPolicy: makeProjectPolicy(),
  projectPolicyRevision: parse(Revision)(0),
  defaultConfiguration: {},
  environmentRef: "local",
  rootWorkspaceId: request.workspaceId,
  primarySession: {
    sessionId: request.sessionId,
    contextEpoch: parse(ContextEpochNumber)(0),
  },
  rootWorkspace: {
    name: "root",
    responsibilityDefinition: definition,
    responsibilityRevision: parse(ResponsibilityRevision)(0),
    resourceSelection,
    agentBinding: responsibilityBound(request.workspaceId),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
});

const rawEnvelope = (request: RequestIds, requestPayload: unknown) => ({
  commandType: "CreateProject",
  commandId: request.commandId,
  projectId: request.projectId,
  actor: ACTOR,
  issuedAt,
  payload: requestPayload,
});

const hostProfile = (
  directory: string,
  version: string,
): HostProjectResourceProfileConfig => ({
  resourceProfileRef: "project-root",
  version,
  displayName: "F21 test workspace",
  directory,
});

const runWith = <A>(
  databaseFile: string,
  projectResourceProfiles: ReturnType<typeof makeProjectResourceProfilePort>,
  program: Effect.Effect<A, unknown, SingleWorkspaceServices>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        program,
        buildSingleWorkspaceLayer({
          databaseFile,
          projectResourceProfiles,
          governance: { authenticatedHumans: [HUMAN], directParentOf: [] },
        }),
      ),
    ),
  ) as Promise<A>;

const submit = (request: RequestIds, requestPayload: unknown) =>
  Effect.gen(function* () {
    const submission = yield* makeExternalSubmissionFromServices({
      authenticatedHumans: [HUMAN],
      directParentOf: [],
    });
    return yield* submission.submit(
      HUMAN,
      externalContext(HUMAN),
      rawEnvelope(request, requestPayload),
    );
  });

const readCounts = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{
    projects: number;
    workspaces: number;
    sessions: number;
    events: number;
    claims: number;
    receipts: number;
    activationIntents: number;
  }>(`SELECT
       (SELECT COUNT(*) FROM projects) AS projects,
       (SELECT COUNT(*) FROM workspaces) AS workspaces,
       (SELECT COUNT(*) FROM sessions) AS sessions,
       (SELECT COUNT(*) FROM domain_events) AS events,
       (SELECT COUNT(*) FROM resource_ownership WHERE released_at IS NULL) AS claims,
       (SELECT COUNT(*) FROM commands) AS receipts,
       (SELECT COUNT(*) FROM workspace_resource_activation_intents) AS activationIntents`);
  return rows[0];
});

describe("F21 CreateProject v2 host resource admission", () => {
  it("rejects raw or mixed caller boundaries before receipt or aggregate writes", async () => {
    const root = tempRoot();
    const databaseFile = join(root, "slice.db");
    const outsidePath = join(root, "unregistered-host-path");
    mkdirSync(outsidePath);
    const request = ids("a1");
    const rawV1Payload = {
      ...payload(request, { _tag: "ConversationOnly" }),
      rootWorkspace: {
        ...payload(request, { _tag: "ConversationOnly" }).rootWorkspace,
        resourceBoundary: {
          basisResponsibilityRevision: 0,
          addresses: [{ _tag: "FileTree", path: outsidePath }],
        },
        resourceBoundaryRevision: 0,
      },
    };
    const mixedPayload = {
      ...payload(request, { _tag: "ConversationOnly" }),
      rootWorkspace: {
        ...payload(request, { _tag: "ConversationOnly" }).rootWorkspace,
        resourceBoundary: {
          basisResponsibilityRevision: 0,
          addresses: [{ _tag: "FileTree", path: outsidePath }],
        },
        resourceBoundaryRevision: 0,
      },
    };
    const response = await runWith(
      databaseFile,
      makeProjectResourceProfilePort([]),
      Effect.gen(function* () {
        yield* runMigrations(CURRENT_MIGRATIONS);
        const raw = yield* submit(request, rawV1Payload);
        const mixed = yield* submit(
          {
            ...request,
            commandId: parse(CommandId)(
              "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
            ),
          },
          mixedPayload,
        );
        return { raw, mixed, counts: yield* readCounts };
      }),
    );
    expect(response.raw).toMatchObject({ ok: false, status: 400 });
    expect(response.mixed).toMatchObject({ ok: false, status: 400 });
    expect(response.counts).toMatchObject({
      projects: 0,
      workspaces: 0,
      sessions: 0,
      events: 0,
      receipts: 0,
      claims: 0,
    });
  });

  it("commits the exact trusted Profile boundary atomically and makes ConversationOnly explicitly empty", async () => {
    const root = tempRoot();
    const directory = join(root, "registered-workspace");
    mkdirSync(directory);
    const databaseFile = join(root, "slice.db");
    const requestProfile = ids("b1");
    const requestConversation = ids("b2");
    const profiles = makeProjectResourceProfilePort([
      hostProfile(directory, "v1"),
    ]);
    const outcome = await runWith(
      databaseFile,
      profiles,
      Effect.gen(function* () {
        yield* runMigrations(CURRENT_MIGRATIONS);
        const selected = yield* submit(
          requestProfile,
          payload(requestProfile, {
            _tag: "Profile",
            resourceProfileRef: "project-root",
            version: "v1",
          }),
        );
        const onlyConversation = yield* submit(
          requestConversation,
          payload(requestConversation, { _tag: "ConversationOnly" }),
        );
        const tx = yield* TransactionPort;
        const workspaces = yield* WorkspaceRepository;
        const profileWorkspace = yield* tx.transact(
          workspaces.findById(requestProfile.workspaceId),
        );
        const conversationWorkspace = yield* tx.transact(
          workspaces.findById(requestConversation.workspaceId),
        );
        const sql = yield* SqlClient;
        const eventVersions = yield* sql.unsafe<{
          project_id: string;
          event_type: string;
          event_version: number;
        }>(
          "SELECT project_id, event_type, event_version FROM domain_events ORDER BY project_id, sequence",
        );
        const activationEvents = yield* sql.unsafe<{
          project_id: string;
          aggregate_ref: string;
          event_version: number;
          payload_json: string;
        }>(
          `SELECT project_id, aggregate_ref, event_version, payload_json
           FROM domain_events
           WHERE event_type = 'WorkspaceResourceActivationChanged'
           ORDER BY project_id, sequence`,
        );
        const activationIntents = yield* sql.unsafe<{
          project_id: string;
          workspace_id: string;
          resource_boundary_revision: number;
          status: string;
          created_at: string;
          updated_at: string;
          activated_at: string | null;
        }>(
          `SELECT project_id, workspace_id, resource_boundary_revision,
                  status, created_at, updated_at, activated_at
           FROM workspace_resource_activation_intents
           ORDER BY project_id, workspace_id, resource_boundary_revision`,
        );
        return {
          selected,
          onlyConversation,
          profileBoundary: Option.isSome(profileWorkspace)
            ? profileWorkspace.value.resourceBoundary
            : null,
          conversationBoundary: Option.isSome(conversationWorkspace)
            ? conversationWorkspace.value.resourceBoundary
            : null,
          eventVersions,
          activationEvents,
          activationIntents,
          counts: yield* readCounts,
        };
      }),
    );
    expect(outcome.selected).toMatchObject({
      ok: true,
      body: { resolution: "Committed" },
    });
    expect(outcome.onlyConversation).toMatchObject({
      ok: true,
      body: { resolution: "Committed" },
    });
    expect(outcome.profileBoundary).toEqual({
      basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
      addresses: [{ _tag: "FileTree", path: realpathSync(directory) }],
    });
    expect(outcome.conversationBoundary).toEqual({
      basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
      addresses: [],
    });
    expect(outcome.eventVersions).toEqual([
      {
        project_id: requestProfile.projectId,
        event_type: "ProjectCreated",
        event_version: 1,
      },
      {
        project_id: requestProfile.projectId,
        event_type: "WorkspaceCreated",
        event_version: 1,
      },
      {
        project_id: requestProfile.projectId,
        event_type: "WorkspaceResourceActivationChanged",
        event_version: 1,
      },
      {
        project_id: requestProfile.projectId,
        event_type: "WorkspaceResourceActivationChanged",
        event_version: 1,
      },
      {
        project_id: requestConversation.projectId,
        event_type: "ProjectCreated",
        event_version: 1,
      },
      {
        project_id: requestConversation.projectId,
        event_type: "WorkspaceCreated",
        event_version: 1,
      },
    ]);
    expect(
      outcome.activationEvents.map((event) => ({
        ...event,
        payload_json: JSON.parse(event.payload_json) as unknown,
      })),
    ).toEqual([
      {
        project_id: requestProfile.projectId,
        aggregate_ref: requestProfile.workspaceId,
        event_version: 1,
        payload_json: {
          _tag: "WorkspaceResourceActivationChanged",
          workspaceId: requestProfile.workspaceId,
          resourceBoundaryRevision: 0,
          status: "Pending",
        },
      },
      {
        project_id: requestProfile.projectId,
        aggregate_ref: requestProfile.workspaceId,
        event_version: 1,
        payload_json: {
          _tag: "WorkspaceResourceActivationChanged",
          workspaceId: requestProfile.workspaceId,
          resourceBoundaryRevision: 0,
          status: "Active",
        },
      },
    ]);
    expect(outcome.activationIntents).toHaveLength(1);
    expect(outcome.activationIntents[0]).toMatchObject({
      project_id: requestProfile.projectId,
      workspace_id: requestProfile.workspaceId,
      resource_boundary_revision: 0,
      status: "Active",
      created_at: issuedAt,
    });
    expect(outcome.activationIntents[0]?.activated_at).toEqual(
      expect.any(String),
    );
    expect(outcome.counts).toMatchObject({
      projects: 2,
      workspaces: 2,
      sessions: 2,
      events: 6,
      claims: 1,
      receipts: 2,
      activationIntents: 1,
    });
  });

  it("terminally records unavailable, forged, and stale selections without canonical writes", async () => {
    const root = tempRoot();
    const available = join(root, "available");
    mkdirSync(available);
    const missing = join(root, "missing");
    const databaseFile = join(root, "slice.db");
    const forgedRequest = ids("c1");
    const staleRequest = ids("c2");
    const unavailableRequest = ids("c3");
    let profileResolveCalls = 0;
    const profileSnapshot = makeProjectResourceProfilePort([
      hostProfile(available, "v2"),
      {
        resourceProfileRef: "offline",
        version: "v1",
        displayName: "Unavailable",
        directory: missing,
      },
    ]);
    const profiles = {
      list: profileSnapshot.list,
      resolve: (resourceProfileRef: string, version: string) => {
        profileResolveCalls += 1;
        return profileSnapshot.resolve(resourceProfileRef, version);
      },
    };
    const responses = await runWith(
      databaseFile,
      profiles,
      Effect.gen(function* () {
        yield* runMigrations(CURRENT_MIGRATIONS);
        const forged = yield* submit(
          forgedRequest,
          payload(forgedRequest, {
            _tag: "Profile",
            resourceProfileRef: "not-registered",
            version: "v1",
          }),
        );
        const stale = yield* submit(
          staleRequest,
          payload(staleRequest, {
            _tag: "Profile",
            resourceProfileRef: "project-root",
            version: "v1",
          }),
        );
        const unavailable = yield* submit(
          unavailableRequest,
          payload(unavailableRequest, {
            _tag: "Profile",
            resourceProfileRef: "offline",
            version: "v1",
          }),
        );
        const forgedReplay = yield* submit(
          forgedRequest,
          payload(forgedRequest, {
            _tag: "Profile",
            resourceProfileRef: "not-registered",
            version: "v1",
          }),
        );
        const repairedWithSameId = yield* submit(
          forgedRequest,
          payload(forgedRequest, {
            _tag: "Profile",
            resourceProfileRef: "project-root",
            version: "v2",
          }),
        );
        return {
          forged,
          stale,
          unavailable,
          forgedReplay,
          repairedWithSameId,
          counts: yield* readCounts,
        };
      }),
    );
    for (const response of [
      responses.forged,
      responses.stale,
      responses.unavailable,
      responses.forgedReplay,
    ]) {
      expect(response).toMatchObject({
        ok: true,
        body: {
          resolution: "TerminalRejected",
          rejection: "ProjectResourceUnavailable",
        },
      });
      expect(JSON.stringify(response)).not.toContain(root);
    }
    expect(responses.counts).toMatchObject({
      projects: 0,
      workspaces: 0,
      sessions: 0,
      events: 0,
      claims: 0,
      receipts: 3,
    });
    expect(profileResolveCalls).toBe(3);
    expect(responses.forgedReplay).toEqual(responses.forged);
    expect(responses.repairedWithSameId).toMatchObject({
      ok: true,
      body: {
        resolution: "TerminalRejected",
        rejection: "IdempotencyConflict",
      },
    });
  });

  it("restarts from the durable Workspace boundary and does not rebind after the Profile version changes", async () => {
    const root = tempRoot();
    const originalDirectory = join(root, "original");
    const replacementDirectory = join(root, "replacement");
    mkdirSync(originalDirectory);
    mkdirSync(replacementDirectory);
    const databaseFile = join(root, "slice.db");
    const request = ids("c4");
    const originalPayload = payload(request, {
      _tag: "Profile",
      resourceProfileRef: "project-root",
      version: "v1",
    });
    const originalPort = makeProjectResourceProfilePort([
      hostProfile(originalDirectory, "v1"),
    ]);
    const created = await runWith(
      databaseFile,
      originalPort,
      Effect.gen(function* () {
        yield* runMigrations(CURRENT_MIGRATIONS);
        const response = yield* submit(request, originalPayload);
        const ownership = yield* ResourceOwnershipRepository;
        const tx = yield* TransactionPort;
        const claims = yield* tx.transact(
          ownership.listActiveByWorkspace(request.workspaceId),
        );
        return { response, claims, counts: yield* readCounts };
      }),
    );
    expect(created.response).toMatchObject({
      ok: true,
      body: { resolution: "Committed" },
    });
    expect(created.claims.map((claim) => claim.sourceAddressSnapshot)).toEqual([
      { _tag: "FileTree", path: realpathSync(originalDirectory) },
    ]);

    const sameSnapshotReplay = await runWith(
      databaseFile,
      makeProjectResourceProfilePort([hostProfile(originalDirectory, "v1")]),
      Effect.gen(function* () {
        yield* runMigrations(CURRENT_MIGRATIONS);
        const response = yield* submit(request, originalPayload);
        const ownership = yield* ResourceOwnershipRepository;
        const tx = yield* TransactionPort;
        const claims = yield* tx.transact(
          ownership.listActiveByWorkspace(request.workspaceId),
        );
        return { response, claims, counts: yield* readCounts };
      }),
    );
    expect(sameSnapshotReplay.response).toMatchObject({
      ok: true,
      body: { resolution: "Committed" },
    });
    expect(
      sameSnapshotReplay.claims.map((claim) => claim.sourceAddressSnapshot),
    ).toEqual([{ _tag: "FileTree", path: realpathSync(originalDirectory) }]);
    expect(sameSnapshotReplay.counts).toMatchObject({
      events: 4,
      activationIntents: 1,
      receipts: 1,
    });

    let changedProfileResolveCalls = 0;
    const changedProfileSnapshot = makeProjectResourceProfilePort([
      hostProfile(replacementDirectory, "v2"),
    ]);
    const changedProfilePort = {
      list: changedProfileSnapshot.list,
      resolve: (resourceProfileRef: string, version: string) => {
        changedProfileResolveCalls += 1;
        return changedProfileSnapshot.resolve(resourceProfileRef, version);
      },
    };
    const changedConfigReplay = await runWith(
      databaseFile,
      changedProfilePort,
      Effect.gen(function* () {
        yield* runMigrations(CURRENT_MIGRATIONS);
        const replay = yield* submit(request, originalPayload);
        const staleNewRequest = ids("c5");
        const stale = yield* submit(
          staleNewRequest,
          payload(staleNewRequest, {
            _tag: "Profile",
            resourceProfileRef: "project-root",
            version: "v1",
          }),
        );
        const ownership = yield* ResourceOwnershipRepository;
        const tx = yield* TransactionPort;
        const claims = yield* tx.transact(
          ownership.listActiveByWorkspace(request.workspaceId),
        );
        return { replay, stale, claims, counts: yield* readCounts };
      }),
    );
    expect(changedConfigReplay.replay).toMatchObject({
      ok: true,
      body: { resolution: "Committed" },
    });
    expect(changedConfigReplay.stale).toMatchObject({
      ok: true,
      body: {
        resolution: "TerminalRejected",
        rejection: "ProjectResourceUnavailable",
      },
    });
    expect(
      changedConfigReplay.claims.map((claim) => claim.sourceAddressSnapshot),
    ).toEqual([{ _tag: "FileTree", path: realpathSync(originalDirectory) }]);
    expect(changedConfigReplay.counts).toMatchObject({
      projects: 1,
      workspaces: 1,
      sessions: 1,
      events: 4,
      claims: 1,
      receipts: 2,
      activationIntents: 1,
    });
    expect(changedProfileResolveCalls).toBe(1);
  });

  it("replays a v1 receipt only as a tuple conflict and leaves its row unchanged", async () => {
    const root = tempRoot();
    const directory = join(root, "registered");
    mkdirSync(directory);
    const request = ids("d1");
    const v2Payload = payload(request, {
      _tag: "Profile",
      resourceProfileRef: "project-root",
      version: "v1",
    });
    const currentShape = payload(request, { _tag: "ConversationOnly" });
    const { resourceSelection: _resourceSelection, ...legacyRoot } =
      currentShape.rootWorkspace;
    const legacyV1Payload = {
      ...currentShape,
      rootWorkspace: {
        ...legacyRoot,
        resourceBoundary: {
          basisResponsibilityRevision: 0,
          addresses: [{ _tag: "FileTree", path: "historical-address" }],
        },
        resourceBoundaryRevision: 0,
      },
    };
    const databaseFile = join(root, "slice.db");
    const profileSnapshot = makeProjectResourceProfilePort([
      hostProfile(directory, "v1"),
    ]);
    let profileResolveCalls = 0;
    const profiles = {
      list: profileSnapshot.list,
      resolve: (resourceProfileRef: string, version: string) => {
        profileResolveCalls += 1;
        return profileSnapshot.resolve(resourceProfileRef, version);
      },
    };
    const outcome = await runWith(
      databaseFile,
      profiles,
      Effect.gen(function* () {
        yield* runMigrations(CURRENT_MIGRATIONS);
        const store = yield* CommandStore;
        const tx = yield* TransactionPort;
        const oldFingerprint = semanticRequestFingerprint({
          commandType: "CreateProject",
          projectId: request.projectId,
          actor: ACTOR,
          schemaVersion: "1",
          payload: legacyV1Payload,
        });
        yield* tx.transact(
          store.insertCommitted(
            request.commandId,
            request.projectId,
            oldFingerprint,
            "1",
            1,
            JSON.stringify({
              projectId: request.projectId,
              rootWorkspaceId: request.workspaceId,
              primarySessionId: request.sessionId,
            }),
          ),
        );
        const before = yield* tx.transact(
          store.findResolution(request.commandId),
        );
        const rawV1 = yield* submit(request, legacyV1Payload);
        const v2Candidate = yield* submit(request, v2Payload);
        const after = yield* tx.transact(
          store.findResolution(request.commandId),
        );
        return {
          before,
          after,
          rawV1,
          v2Candidate,
          counts: yield* readCounts,
        };
      }),
    );
    expect(outcome.before).toEqual(outcome.after);
    expect(outcome.rawV1).toMatchObject({ ok: false, status: 400 });
    expect(outcome.v2Candidate).toMatchObject({
      ok: true,
      body: {
        resolution: "TerminalRejected",
        rejection: "IdempotencyConflict",
      },
    });
    expect(outcome.counts).toMatchObject({
      projects: 0,
      workspaces: 0,
      sessions: 0,
      events: 0,
      claims: 0,
      receipts: 1,
      activationIntents: 0,
    });
    expect(profileResolveCalls).toBe(0);
  });
});
