import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../adapters/persistence-sqlite/src/index.js";
import {
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  TransportBoundary,
} from "../../../apps/single-workspace/src/index.js";
import { makeProjectResourceProfilePort } from "../../../apps/single-workspace/src/project-resource-profiles.js";
import {
  makeLocalAuthenticator,
  makeStaticAuthenticator,
} from "../../../apps/single-workspace/src/transport/auth.js";
import { viewQueryFaceFromPort } from "../../../apps/single-workspace/src/transport/composition.js";
import type { ConversationProgressHub } from "../../../apps/single-workspace/src/transport/conversation-progress.js";
import { createConversationProgressHub } from "../../../apps/single-workspace/src/transport/conversation-progress.js";
import { makeTransportCore } from "../../../apps/single-workspace/src/transport/core.js";
import { makeHttpShell } from "../../../apps/single-workspace/src/transport/http.js";
import {
  startWebTransport,
  type WebTransportHandle,
} from "../../../apps/single-workspace/src/transport/server.js";
import {
  Principal,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
} from "../../../packages/domain/src/index.js";
import {
  ProjectDirectory,
  ProjectionQueryPort,
  ProjectResourceProfilePort,
  TransactionPort,
  WorkspaceRepository,
} from "../../../packages/ports/src/index.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
} from "../../support/p7-app.js";

interface ViewObservation {
  readonly status: number;
  readonly denied: boolean;
  readonly canonicalPathReturned: boolean;
  readonly workspaceIdReturned: boolean;
  readonly projectNameReturned: boolean;
  readonly projectIdReturned: boolean;
}

interface CatalogObservation {
  readonly status: number;
  readonly denied: boolean;
  readonly canonicalPathReturned: boolean;
}

interface ProgressObservation {
  readonly status: number;
  readonly denied: boolean;
  readonly eventStream: boolean;
}

const handles: WebTransportHandle[] = [];
const directories: string[] = [];

const containsValue = (value: unknown, expected: string): boolean => {
  if (typeof value === "string") return value === expected;
  if (Array.isArray(value))
    return value.some((item) => containsValue(item, expected));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => containsValue(item, expected));
  }
  return false;
};

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("pending P12 view read authentication boundary", () => {
  it("denies remote unauthenticated/foreign reads without hiding local authorized paths", async () => {
    let projectionReads = 0;
    let projectDirectoryReads = 0;
    let progressSubscriptions = 0;
    const directory = mkdtempSync(join(tmpdir(), "p12-view-read-auth-"));
    directories.push(directory);
    const resourceDirectory = join(directory, "canonical-host-resource");
    mkdirSync(resourceDirectory);
    const canonicalPath = realpathSync(resourceDirectory);
    const localPrincipal = parse(Principal)("user:local");
    const foreignPrincipal = parse(Principal)("user:foreign");
    const authenticator = makeStaticAuthenticator({
      "valid-local-token": localPrincipal,
      "foreign-user-token": foreignPrincipal,
    });
    const app = buildSingleWorkspaceLayer({
      databaseFile: join(directory, "arbor.db"),
      blobRoot: join(directory, "blobs"),
      authenticator,
      projectResourceProfiles: makeProjectResourceProfilePort([]),
    });

    const report = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(CURRENT_MIGRATIONS);
            yield* p7SeedProject;
            const sql = yield* SqlClient;
            const tx = yield* TransactionPort;
            const workspaces = yield* WorkspaceRepository;
            const projection = yield* ProjectionQueryPort;
            const projectDirectory = yield* ProjectDirectory;
            const profiles = yield* ProjectResourceProfilePort;
            const boundary = yield* TransportBoundary;
            const queryFace = viewQueryFaceFromPort(projection);
            const tracedQueryFace = {
              query: (...args: Parameters<typeof queryFace.query>) => {
                projectionReads += 1;
                return queryFace.query(...args);
              },
            } as typeof queryFace;
            const tracedProjectDirectory = {
              list: () => {
                projectDirectoryReads += 1;
                return projectDirectory.list();
              },
            } as typeof projectDirectory;
            const baseProgressHub = createConversationProgressHub();
            const tracedProgressHub: ConversationProgressHub = {
              publish: (...args) => baseProgressHub.publish(...args),
              subscribe: (...args) => {
                progressSubscriptions += 1;
                return baseProgressHub.subscribe(...args);
              },
              close: () => baseProgressHub.close(),
            };

            const progressMessageId =
              "msg_018f2b3c-4d5e-7abc-8def-0123456789c2";
            yield* sql.unsafe(
              `INSERT INTO human_messages (
                 message_id, project_id, root_workspace_id, human_principal,
                 body_ref, command_id, fingerprint, state, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?)`,
              [
                progressMessageId,
                String(p7Project),
                String(p7RootWorkspace),
                "user:local",
                "blob_test_progress",
                "cmd_018f2b3c-4d5e-7abc-8def-0123456789c2",
                "test-progress-fingerprint",
                "2026-10-10T00:00:00.000Z",
              ],
            );

            yield* tx.transact(
              workspaces.updateResourceBoundaryIfRevision(
                p7RootWorkspace,
                parse(Revision)(0),
                {
                  basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
                  addresses: [{ _tag: "FileTree", path: canonicalPath }],
                },
                parse(ResourceBoundaryRevision)(1),
                parse(Revision)(1),
              ),
            );

            const localHttp = makeHttpShell(
              makeTransportCore({
                views: tracedQueryFace,
                authenticator: makeLocalAuthenticator(),
                submission: boundary.submission,
              }),
            );
            const authenticatedHttp = makeHttpShell(
              makeTransportCore({
                views: tracedQueryFace,
                authenticator,
                submission: boundary.submission,
              }),
            );
            const start = (options: {
              readonly http: typeof localHttp;
              readonly host: string;
              readonly configuredAuthenticator?: typeof authenticator;
            }) =>
              Effect.promise(() =>
                startWebTransport({
                  http: options.http,
                  webSocket: boundary.webSocket,
                  conversationProgress: tracedProgressHub,
                  ...(options.configuredAuthenticator === undefined
                    ? {}
                    : { authenticator: options.configuredAuthenticator }),
                  sql,
                  projectDirectory: tracedProjectDirectory,
                  projectResourceProfiles: profiles,
                  host: options.host,
                  port: 0,
                  pollIntervalMs: 60_000,
                }),
              );

            const remoteWithoutAuth = yield* start({
              http: localHttp,
              host: "0.0.0.0",
            });
            handles.push(remoteWithoutAuth);
            const remoteWithAuth = yield* start({
              http: authenticatedHttp,
              host: "0.0.0.0",
              configuredAuthenticator: authenticator,
            });
            handles.push(remoteWithAuth);
            const localLoopback = yield* start({
              http: localHttp,
              host: "127.0.0.1",
            });
            handles.push(localLoopback);

            const query = (
              port: number,
              view: string,
              request: unknown,
              token?: string,
            ) =>
              Effect.promise(async (): Promise<ViewObservation> => {
                const response = await fetch(
                  `http://127.0.0.1:${String(port)}/views/${view}`,
                  {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      ...(token === undefined
                        ? {}
                        : { authorization: `Bearer ${token}` }),
                    },
                    body: JSON.stringify(request),
                  },
                );
                const body: unknown = await response.json();
                return {
                  status: response.status,
                  denied: response.status >= 400,
                  canonicalPathReturned: containsValue(body, canonicalPath),
                  workspaceIdReturned: containsValue(
                    body,
                    String(p7RootWorkspace),
                  ),
                  projectNameReturned: containsValue(body, "p6"),
                  projectIdReturned: containsValue(body, String(p7Project)),
                };
              });

            const readProjects = (port: number, token?: string) =>
              Effect.promise(async (): Promise<ViewObservation> => {
                const response = await fetch(
                  `http://127.0.0.1:${String(port)}/projects`,
                  token === undefined
                    ? {}
                    : { headers: { authorization: `Bearer ${token}` } },
                );
                const body: unknown = await response.json();
                return {
                  status: response.status,
                  denied: response.status >= 400,
                  canonicalPathReturned: containsValue(body, canonicalPath),
                  workspaceIdReturned: containsValue(
                    body,
                    String(p7RootWorkspace),
                  ),
                  projectNameReturned: containsValue(body, "p6"),
                  projectIdReturned: containsValue(body, String(p7Project)),
                };
              });

            const readCatalog = (port: number, token?: string) =>
              Effect.promise(async (): Promise<CatalogObservation> => {
                const response = await fetch(
                  `http://127.0.0.1:${String(port)}/project-resources`,
                  token === undefined
                    ? {}
                    : { headers: { authorization: `Bearer ${token}` } },
                );
                const body: unknown = await response.json();
                return {
                  status: response.status,
                  denied: response.status >= 400,
                  canonicalPathReturned: containsValue(body, canonicalPath),
                };
              });

            const projectionReadsBeforeNoAuthViews = projectionReads;
            const noAuthDetail = yield* query(
              remoteWithoutAuth.port,
              "workspace-detail",
              { workspaceId: p7RootWorkspace },
            );
            const noAuthTree = yield* query(
              remoteWithoutAuth.port,
              "responsibility-tree",
              { projectId: p7Project },
            );
            const noAuthViewSourceCalls =
              projectionReads - projectionReadsBeforeNoAuthViews;
            const projectDirectoryReadsBeforeNoAuth = projectDirectoryReads;
            const noAuthProjects = yield* readProjects(remoteWithoutAuth.port);
            const noAuthProjectSourceCalls =
              projectDirectoryReads - projectDirectoryReadsBeforeNoAuth;
            const projectionReadsBeforeConfiguredDenied = projectionReads;
            const missingTokenDetail = yield* query(
              remoteWithAuth.port,
              "workspace-detail",
              { workspaceId: p7RootWorkspace },
            );
            const invalidTokenTree = yield* query(
              remoteWithAuth.port,
              "responsibility-tree",
              { projectId: p7Project },
              "invalid-token",
            );
            const foreignPrincipalDetail = yield* query(
              remoteWithAuth.port,
              "workspace-detail",
              { workspaceId: p7RootWorkspace },
              "foreign-user-token",
            );
            const configuredDeniedViewSourceCalls =
              projectionReads - projectionReadsBeforeConfiguredDenied;
            const projectDirectoryReadsBeforeConfiguredDenied =
              projectDirectoryReads;
            const missingTokenProjects = yield* readProjects(
              remoteWithAuth.port,
            );
            const invalidTokenProjects = yield* readProjects(
              remoteWithAuth.port,
              "invalid-token",
            );
            const foreignPrincipalProjects = yield* readProjects(
              remoteWithAuth.port,
              "foreign-user-token",
            );
            const configuredDeniedProjectSourceCalls =
              projectDirectoryReads -
              projectDirectoryReadsBeforeConfiguredDenied;
            const authorizedDetail = yield* query(
              remoteWithAuth.port,
              "workspace-detail",
              { workspaceId: p7RootWorkspace },
              "valid-local-token",
            );
            const authorizedProjects = yield* readProjects(
              remoteWithAuth.port,
              "valid-local-token",
            );
            const loopbackDetail = yield* query(
              localLoopback.port,
              "workspace-detail",
              { workspaceId: p7RootWorkspace },
            );
            const loopbackProjects = yield* readProjects(localLoopback.port);
            const noAuthCatalog = yield* readCatalog(remoteWithoutAuth.port);
            const authorizedCatalog = yield* readCatalog(
              remoteWithAuth.port,
              "valid-local-token",
            );

            const progressRead = (port: number, token?: string) =>
              Effect.promise(async (): Promise<ProgressObservation> => {
                const response = await fetch(
                  `http://127.0.0.1:${String(port)}/conversation-progress/${progressMessageId}`,
                  {
                    headers: {
                      ...(token === undefined
                        ? {}
                        : { authorization: `Bearer ${token}` }),
                    },
                  },
                );
                const observation = {
                  status: response.status,
                  denied: response.status >= 400,
                  eventStream:
                    response.headers
                      .get("content-type")
                      ?.includes("text/event-stream") ?? false,
                };
                await response.body?.cancel();
                return observation;
              });
            const progressSubscriptionsBefore = progressSubscriptions;
            const noAuthProgress = yield* progressRead(remoteWithoutAuth.port);
            const noAuthProgressSourceCalls =
              progressSubscriptions - progressSubscriptionsBefore;
            const validTokenProgress = yield* progressRead(
              remoteWithAuth.port,
              "valid-local-token",
            );
            const loopbackProgress = yield* progressRead(localLoopback.port);

            const unsupportedMethodMatrix = yield* Effect.promise(async () => {
              const before = projectionReads;
              const observations: Array<{ method: string; status: number }> =
                [];
              for (const method of [
                "GET",
                "PUT",
                "PATCH",
                "DELETE",
                "OPTIONS",
              ]) {
                const response = await fetch(
                  `http://127.0.0.1:${String(remoteWithAuth.port)}/views/workspace-detail`,
                  { method },
                );
                observations.push({ method, status: response.status });
                await response.body?.cancel();
              }
              return {
                observations,
                sourceCalls: projectionReads - before,
              };
            });

            return {
              noAuthDetail,
              noAuthTree,
              noAuthProjects,
              missingTokenDetail,
              invalidTokenTree,
              foreignPrincipalDetail,
              missingTokenProjects,
              invalidTokenProjects,
              foreignPrincipalProjects,
              authorizedDetail,
              authorizedProjects,
              loopbackDetail,
              loopbackProjects,
              noAuthCatalog,
              authorizedCatalog,
              noAuthProjectSourceCalls,
              noAuthViewSourceCalls,
              configuredDeniedViewSourceCalls,
              configuredDeniedProjectSourceCalls,
              noAuthProgress,
              noAuthProgressSourceCalls,
              validTokenProgress,
              loopbackProgress,
              unsupportedMethodMatrix,
            };
          }),
          app,
        ),
      ),
    );

    const unauthorized = [
      report.noAuthDetail,
      report.noAuthTree,
      report.noAuthProjects,
      report.missingTokenDetail,
      report.invalidTokenTree,
      report.foreignPrincipalDetail,
      report.missingTokenProjects,
      report.invalidTokenProjects,
      report.foreignPrincipalProjects,
    ];
    expect(report.authorizedDetail).toMatchObject({
      status: 200,
      denied: false,
      canonicalPathReturned: true,
    });
    expect(report.authorizedProjects).toMatchObject({
      status: 200,
      denied: false,
      projectNameReturned: true,
      projectIdReturned: true,
    });
    expect(report.loopbackDetail).toMatchObject({
      status: 200,
      denied: false,
      canonicalPathReturned: true,
    });
    expect(report.loopbackProjects).toMatchObject({
      status: 200,
      denied: false,
      projectNameReturned: true,
      projectIdReturned: true,
    });
    expect(report.noAuthCatalog).toMatchObject({
      status: 503,
      denied: true,
      canonicalPathReturned: false,
    });
    expect(report.authorizedCatalog).toMatchObject({
      status: 200,
      denied: false,
      canonicalPathReturned: false,
    });
    expect(report.validTokenProgress).toMatchObject({
      status: 200,
      denied: false,
      eventStream: true,
    });
    expect(report.loopbackProgress).toMatchObject({
      status: 200,
      denied: false,
      eventStream: true,
    });
    expect({
      unauthorizedObservations: unauthorized.filter(
        (observation) =>
          !observation.denied ||
          observation.canonicalPathReturned ||
          observation.workspaceIdReturned ||
          observation.projectNameReturned ||
          observation.projectIdReturned,
      ).length,
      projectDirectorySourceCalls: report.noAuthProjectSourceCalls,
      noAuthViewSourceCalls: report.noAuthViewSourceCalls,
      configuredDeniedViewSourceCalls: report.configuredDeniedViewSourceCalls,
      configuredDeniedProjectSourceCalls:
        report.configuredDeniedProjectSourceCalls,
      wildcardProgress: {
        status: report.noAuthProgress.status,
        denied: report.noAuthProgress.denied,
        eventStream: report.noAuthProgress.eventStream,
        sourceCalls: report.noAuthProgressSourceCalls,
      },
      unsupportedViewMethods: report.unsupportedMethodMatrix,
    }).toEqual({
      unauthorizedObservations: 0,
      projectDirectorySourceCalls: 0,
      noAuthViewSourceCalls: 0,
      configuredDeniedViewSourceCalls: 0,
      configuredDeniedProjectSourceCalls: 0,
      wildcardProgress: {
        status: 503,
        denied: true,
        eventStream: false,
        sourceCalls: 0,
      },
      unsupportedViewMethods: {
        observations: [
          { method: "GET", status: 400 },
          { method: "PUT", status: 400 },
          { method: "PATCH", status: 400 },
          { method: "DELETE", status: 400 },
          { method: "OPTIONS", status: 400 },
        ],
        sourceCalls: 0,
      },
    });
  }, 45_000);
});
