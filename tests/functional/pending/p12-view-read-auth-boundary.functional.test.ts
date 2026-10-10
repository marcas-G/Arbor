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

const handles: WebTransportHandle[] = [];
const directories: string[] = [];

const observeUnauthenticatedWildcardWebSocket = (
  port: number,
  publish: () => void,
): Promise<{ readonly connected: boolean; readonly frameReceived: boolean }> =>
  new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    let connected = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (frameReceived: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ connected, frameReceived });
      socket.close();
    };
    socket.onopen = () => {
      connected = true;
      timer = setTimeout(() => finish(false), 100);
      publish();
    };
    socket.onmessage = () => finish(true);
    socket.onerror = () => finish(false);
    socket.onclose = () => finish(false);
  });

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
                views: viewQueryFaceFromPort(projection),
                authenticator: makeLocalAuthenticator(),
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
                  ...(options.configuredAuthenticator === undefined
                    ? {}
                    : { authenticator: options.configuredAuthenticator }),
                  sql,
                  projectDirectory,
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
              http: boundary.http,
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
            const noAuthProjects = yield* readProjects(remoteWithoutAuth.port);
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
            const wildcardWebSocket = yield* Effect.promise(() =>
              observeUnauthenticatedWildcardWebSocket(
                remoteWithoutAuth.port,
                () => remoteWithoutAuth.fanout.publishWatermark(777),
              ),
            );

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
              wildcardWebSocket,
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
    expect({
      unauthorizedObservations: unauthorized.filter(
        (observation) =>
          !observation.denied ||
          observation.canonicalPathReturned ||
          observation.workspaceIdReturned ||
          observation.projectNameReturned ||
          observation.projectIdReturned,
      ).length,
      wildcardWebSocket: report.wildcardWebSocket,
    }).toEqual({
      unauthorizedObservations: 0,
      wildcardWebSocket: { connected: false, frameReceived: false },
    });
  }, 45_000);
});
