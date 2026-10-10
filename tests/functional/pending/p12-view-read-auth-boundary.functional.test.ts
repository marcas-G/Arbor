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
import {
  type HttpShell,
  makeHttpShell,
} from "../../../apps/single-workspace/src/transport/http.js";
import {
  startWebTransport,
  type WebTransportHandle,
} from "../../../apps/single-workspace/src/transport/server.js";
import { makeWebSocketShell } from "../../../apps/single-workspace/src/transport/websocket.js";
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

interface WebSocketOpenObservation {
  readonly socket: WebSocket;
  readonly opened: boolean;
}

const handles: WebTransportHandle[] = [];
const directories: string[] = [];

const openWebSocket = (port: number): Promise<WebSocketOpenObservation> =>
  new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    let settled = false;
    const finish = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ socket, opened });
    };
    socket.onopen = () => finish(true);
    socket.onerror = () => finish(false);
    socket.onclose = () => finish(false);
  });

const nextWebSocketMessage = (
  socket: WebSocket,
  timeoutMs = 150,
): Promise<unknown | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.onmessage = null;
      resolve(null);
    }, timeoutMs);
    socket.onmessage = (event) => {
      clearTimeout(timer);
      socket.onmessage = null;
      try {
        resolve(JSON.parse(String(event.data)) as unknown);
      } catch {
        resolve(null);
      }
    };
  });

const waitForWebSocketClose = (
  socket: WebSocket,
  timeoutMs = 150,
): Promise<boolean> =>
  new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve(true);
      return;
    }
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onclose = null;
      resolve(closed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.onclose = () => finish(true);
  });

const sanitizeWebSocketMessage = (
  value: unknown,
): {
  readonly kind: string;
  readonly ok?: boolean;
  readonly status?: number;
} => {
  if (typeof value !== "object" || value === null) return { kind: "other" };
  const record = value as Record<string, unknown>;
  if (record.kind === "invalidate") return { kind: "invalidate" };
  return {
    kind: "response",
    ok: record.ok === true,
    ...(typeof record.status === "number" ? { status: record.status } : {}),
  };
};

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
            const authenticatedWebSocket = makeWebSocketShell(
              makeTransportCore({
                views: tracedQueryFace,
                authenticator,
                submission: boundary.submission,
              }),
            );
            const start = (options: {
              readonly http: typeof localHttp;
              readonly host: string;
              readonly webSocket?: typeof boundary.webSocket;
              readonly configuredAuthenticator?: typeof authenticator;
            }) =>
              Effect.promise(() =>
                startWebTransport({
                  http: options.http,
                  webSocket: options.webSocket ?? boundary.webSocket,
                  authenticatorConfigured:
                    options.configuredAuthenticator !== undefined,
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
              webSocket: authenticatedWebSocket,
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

            const webSocketQualification = yield* Effect.promise(async () => {
              const unproved = await openWebSocket(remoteWithAuth.port);
              let preProofMessage: unknown | null = null;
              let preProofQueryCalls = 0;
              if (unproved.opened) {
                const before = projectionReads;
                const nextMessage = nextWebSocketMessage(unproved.socket);
                remoteWithAuth.fanout.publishWatermark(880);
                preProofMessage = await nextMessage;
                preProofQueryCalls = projectionReads - before;
                unproved.socket.close();
              }

              const deniedFrames: Array<{
                readonly opened: boolean;
                readonly closed: boolean;
                readonly response: ReturnType<
                  typeof sanitizeWebSocketMessage
                > | null;
                readonly queryCalls: number;
              }> = [];
              for (const token of [
                undefined,
                "invalid-token",
                "foreign-user-token",
              ]) {
                const connection = await openWebSocket(remoteWithAuth.port);
                if (!connection.opened) {
                  deniedFrames.push({
                    opened: false,
                    closed: true,
                    response: null,
                    queryCalls: 0,
                  });
                  continue;
                }
                const before = projectionReads;
                const message = nextWebSocketMessage(connection.socket);
                const closed = waitForWebSocketClose(connection.socket);
                connection.socket.send(
                  JSON.stringify({
                    kind: "view",
                    ...(token === undefined ? {} : { token }),
                    view: "responsibility-tree",
                    request: { projectId: p7Project },
                  }),
                );
                const [rawMessage, socketClosed] = await Promise.all([
                  message,
                  closed,
                ]);
                deniedFrames.push({
                  opened: true,
                  closed: socketClosed,
                  response:
                    rawMessage === null
                      ? null
                      : sanitizeWebSocketMessage(rawMessage),
                  queryCalls: projectionReads - before,
                });
                connection.socket.close();
              }

              const authorized = await openWebSocket(remoteWithAuth.port);
              let authorizedResponse: ReturnType<
                typeof sanitizeWebSocketMessage
              > | null = null;
              let authorizedInvalidation: ReturnType<
                typeof sanitizeWebSocketMessage
              > | null = null;
              let authorizedQueryCalls = 0;
              if (authorized.opened) {
                const before = projectionReads;
                const response = nextWebSocketMessage(authorized.socket);
                authorized.socket.send(
                  JSON.stringify({
                    kind: "view",
                    token: "valid-local-token",
                    view: "responsibility-tree",
                    request: { projectId: p7Project },
                  }),
                );
                const rawResponse = await response;
                authorizedResponse =
                  rawResponse === null
                    ? null
                    : sanitizeWebSocketMessage(rawResponse);
                authorizedQueryCalls = projectionReads - before;
                const invalidation = nextWebSocketMessage(authorized.socket);
                remoteWithAuth.fanout.publishWatermark(881);
                const rawInvalidation = await invalidation;
                authorizedInvalidation =
                  rawInvalidation === null
                    ? null
                    : sanitizeWebSocketMessage(rawInvalidation);
                authorized.socket.close();
              }

              const commandOnly = await openWebSocket(remoteWithAuth.port);
              let commandOnlyInvalidation: ReturnType<
                typeof sanitizeWebSocketMessage
              > | null = null;
              let commandOnlyQueryCalls = 0;
              if (commandOnly.opened) {
                const commandResponse = nextWebSocketMessage(
                  commandOnly.socket,
                );
                commandOnly.socket.send(
                  JSON.stringify({
                    kind: "command",
                    token: "valid-local-token",
                    envelope: {},
                  }),
                );
                await commandResponse;
                const invalidation = nextWebSocketMessage(commandOnly.socket);
                const before = projectionReads;
                remoteWithAuth.fanout.publishWatermark(882);
                const rawInvalidation = await invalidation;
                commandOnlyInvalidation =
                  rawInvalidation === null
                    ? null
                    : sanitizeWebSocketMessage(rawInvalidation);
                commandOnlyQueryCalls = projectionReads - before;
                commandOnly.socket.close();
              }

              return {
                unproved: {
                  opened: unproved.opened,
                  message:
                    preProofMessage === null
                      ? null
                      : sanitizeWebSocketMessage(preProofMessage),
                  queryCalls: preProofQueryCalls,
                },
                deniedFrames,
                authorized: {
                  opened: authorized.opened,
                  response: authorizedResponse,
                  invalidation: authorizedInvalidation,
                  queryCalls: authorizedQueryCalls,
                },
                commandOnly: {
                  opened: commandOnly.opened,
                  invalidation: commandOnlyInvalidation,
                  queryCalls: commandOnlyQueryCalls,
                },
              };
            });

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
              webSocketQualification,
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
      webSocketQualification: report.webSocketQualification,
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
      webSocketQualification: {
        unproved: {
          opened: true,
          message: null,
          queryCalls: 0,
        },
        deniedFrames: [
          {
            opened: true,
            closed: true,
            response: null,
            queryCalls: 0,
          },
          {
            opened: true,
            closed: true,
            response: null,
            queryCalls: 0,
          },
          {
            opened: true,
            closed: true,
            response: null,
            queryCalls: 0,
          },
        ],
        authorized: {
          opened: true,
          response: { kind: "response", ok: true, status: 200 },
          invalidation: { kind: "invalidate" },
          queryCalls: 1,
        },
        commandOnly: {
          opened: true,
          invalidation: null,
          queryCalls: 0,
        },
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

  it("uses explicit local-single-user configuration, not Composition's fallback object, for wildcard reads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p12-composition-auth-mode-"));
    directories.push(directory);
    const app = buildSingleWorkspaceLayer({
      databaseFile: join(directory, "arbor.db"),
      blobRoot: join(directory, "blobs"),
      projectResourceProfiles: makeProjectResourceProfilePort([]),
    });
    let projectListCalls = 0;
    let profileListCalls = 0;
    let viewQueryCalls = 0;
    let progressSubscriptionCalls = 0;

    const report = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(CURRENT_MIGRATIONS);
            yield* p7SeedProject;
            const sql = yield* SqlClient;
            const boundary = yield* TransportBoundary;
            const projectDirectory = yield* ProjectDirectory;
            const profiles = yield* ProjectResourceProfilePort;
            const fallbackMessageId =
              "msg_018f2b3c-4d5e-7abc-8def-0123456789c3";
            yield* sql.unsafe(
              `INSERT INTO human_messages (
                 message_id, project_id, root_workspace_id, human_principal,
                 body_ref, command_id, fingerprint, state, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?)`,
              [
                fallbackMessageId,
                String(p7Project),
                String(p7RootWorkspace),
                "user:local",
                "blob_test_fallback_progress",
                "cmd_018f2b3c-4d5e-7abc-8def-0123456789c3",
                "test-fallback-progress-fingerprint",
                "2026-10-10T00:00:00.000Z",
              ],
            );
            const baseHub = createConversationProgressHub();
            const progressHub: ConversationProgressHub = {
              publish: (...args) => baseHub.publish(...args),
              subscribe: (...args) => {
                progressSubscriptionCalls += 1;
                return baseHub.subscribe(...args);
              },
              close: () => baseHub.close(),
            };
            const http: HttpShell = {
              authorizeSensitiveRead: (authorization) =>
                boundary.http.authorizeSensitiveRead(authorization),
              handle: (request) => boundary.http.handle(request),
              handleAuthorizedView: (request) => {
                viewQueryCalls += 1;
                return boundary.http.handleAuthorizedView(request);
              },
            };
            const tracedProjectDirectory = {
              list: () => {
                projectListCalls += 1;
                return projectDirectory.list();
              },
            } as typeof projectDirectory;
            const tracedProfiles = {
              list: () => {
                profileListCalls += 1;
                return profiles.list();
              },
            } as typeof profiles;
            const start = (host: string) =>
              Effect.promise(() =>
                startWebTransport({
                  http,
                  webSocket: boundary.webSocket,
                  // Production's Composition fallback is non-null even when
                  // no authenticator was configured by main/environment.
                  authenticator: boundary.authenticator,
                  authenticatorConfigured: boundary.authenticatorConfigured,
                  conversationProgress: progressHub,
                  sql,
                  projectDirectory: tracedProjectDirectory,
                  projectResourceProfiles: tracedProfiles,
                  host,
                  port: 0,
                  pollIntervalMs: 60_000,
                }),
              );
            const wildcard = yield* start("0.0.0.0");
            handles.push(wildcard);
            const loopback = yield* start("127.0.0.1");
            handles.push(loopback);
            const request = async (
              port: number,
              path: string,
              method = "GET",
              body?: unknown,
            ) => {
              const response = await fetch(
                `http://127.0.0.1:${String(port)}${path}`,
                {
                  method,
                  ...(body === undefined
                    ? {}
                    : {
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify(body),
                      }),
                },
              );
              const result = {
                status: response.status,
                eventStream:
                  response.headers
                    .get("content-type")
                    ?.includes("text/event-stream") ?? false,
              };
              await response.body?.cancel();
              return result;
            };

            const observations = yield* Effect.promise(async () => {
              const wildcardProjects = await request(
                wildcard.port,
                "/projects",
              );
              const wildcardViews = await request(
                wildcard.port,
                "/views/responsibility-tree",
                "POST",
                { projectId: p7Project },
              );
              const wildcardProgress = await request(
                wildcard.port,
                `/conversation-progress/${fallbackMessageId}`,
              );
              const wildcardCatalog = await request(
                wildcard.port,
                "/project-resources",
              );
              const wildcardSourceCalls = {
                projectList: projectListCalls,
                profileList: profileListCalls,
                viewQuery: viewQueryCalls,
                progressSubscribe: progressSubscriptionCalls,
              };

              const loopbackProjects = await request(
                loopback.port,
                "/projects",
              );
              const loopbackViews = await request(
                loopback.port,
                "/views/responsibility-tree",
                "POST",
                { projectId: p7Project },
              );
              const loopbackProgress = await request(
                loopback.port,
                `/conversation-progress/${fallbackMessageId}`,
              );
              const loopbackCatalog = await request(
                loopback.port,
                "/project-resources",
              );
              const wildcardSocket = await openWebSocket(wildcard.port);
              let wildcardSocketFrame: ReturnType<
                typeof sanitizeWebSocketMessage
              > | null = null;
              if (wildcardSocket.opened) {
                const message = nextWebSocketMessage(wildcardSocket.socket);
                wildcard.fanout.publishWatermark(883);
                const rawMessage = await message;
                wildcardSocketFrame =
                  rawMessage === null
                    ? null
                    : sanitizeWebSocketMessage(rawMessage);
                wildcardSocket.socket.close();
              }
              const loopbackSocket = await openWebSocket(loopback.port);
              let loopbackSocketResponse: ReturnType<
                typeof sanitizeWebSocketMessage
              > | null = null;
              let loopbackSocketInvalidation: ReturnType<
                typeof sanitizeWebSocketMessage
              > | null = null;
              if (loopbackSocket.opened) {
                const response = nextWebSocketMessage(loopbackSocket.socket);
                loopbackSocket.socket.send(
                  JSON.stringify({
                    kind: "view",
                    view: "responsibility-tree",
                    request: { projectId: p7Project },
                  }),
                );
                const rawResponse = await response;
                loopbackSocketResponse =
                  rawResponse === null
                    ? null
                    : sanitizeWebSocketMessage(rawResponse);
                const invalidation = nextWebSocketMessage(
                  loopbackSocket.socket,
                );
                loopback.fanout.publishWatermark(884);
                const rawInvalidation = await invalidation;
                loopbackSocketInvalidation =
                  rawInvalidation === null
                    ? null
                    : sanitizeWebSocketMessage(rawInvalidation);
                loopbackSocket.socket.close();
              }
              return {
                wildcardProjects,
                wildcardViews,
                wildcardProgress,
                wildcardCatalog,
                wildcardSourceCalls,
                loopbackProjects,
                loopbackViews,
                loopbackProgress,
                loopbackCatalog,
                wildcardSocket: {
                  opened: wildcardSocket.opened,
                  frame: wildcardSocketFrame,
                },
                loopbackSocket: {
                  opened: loopbackSocket.opened,
                  response: loopbackSocketResponse,
                  invalidation: loopbackSocketInvalidation,
                },
              };
            });

            return {
              compositionFallbackAuthenticatorPresent:
                boundary.authenticator !== undefined,
              compositionAuthenticatorConfigured:
                boundary.authenticatorConfigured,
              ...observations,
            };
          }),
          app,
        ),
      ),
    );

    expect(report.compositionFallbackAuthenticatorPresent).toBe(true);
    expect(report.compositionAuthenticatorConfigured).toBe(false);
    expect(report.wildcardProjects.status).toBe(503);
    expect(report.wildcardViews.status).toBe(503);
    expect(report.wildcardProgress).toMatchObject({
      status: 503,
      eventStream: false,
    });
    expect(report.wildcardCatalog.status).toBe(503);
    expect(report.wildcardSourceCalls).toEqual({
      projectList: 0,
      profileList: 0,
      viewQuery: 0,
      progressSubscribe: 0,
    });
    expect(report.loopbackProjects.status).toBe(200);
    expect(report.loopbackViews.status).toBe(200);
    expect(report.loopbackProgress).toMatchObject({
      status: 200,
      eventStream: true,
    });
    expect(report.loopbackCatalog.status).toBe(200);
    expect(report.wildcardSocket).toEqual({
      opened: false,
      frame: null,
    });
    expect(report.loopbackSocket).toEqual({
      opened: true,
      response: { kind: "response", ok: true, status: 200 },
      invalidation: { kind: "invalidate" },
    });
  }, 45_000);
});
