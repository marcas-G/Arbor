import { Effect } from "effect";
import { expect } from "vitest";
import {
  layer,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import { P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION } from "../../adapters/persistence-sqlite/src/p57-workspace-sandbox-authorization-migration.js";
import { buildSingleWorkspaceLayer } from "../../apps/single-workspace/src/composition.js";
import { makeExternalSubmissionFromServices } from "../../apps/single-workspace/src/transport/composition.js";
import { ProjectionQueryPort } from "../../packages/ports/src/index.js";
import {
  factory,
  human,
  humanContext,
  now,
  payload,
  projectId,
  root,
  seed,
  uuid,
} from "./support.js";

export const retainsAuthorizationAcrossReopenings = async (): Promise<void> => {
  const fixture = factory.create();
  try {
    seed(fixture.databaseFilename);
    await Effect.runPromise(
      Effect.provide(
        runMigrations([P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION], {
          allowOfflineOnly: true,
        }),
        layer({ filename: fixture.databaseFilename }),
      ),
    );
    const open = () =>
      buildSingleWorkspaceLayer({
        databaseFile: fixture.databaseFilename,
        governance: { authenticatedHumans: [human], directParentOf: [] },
      });
    const send = (
      n: number,
      commandType:
        | "AuthorizeWorkspaceSandbox"
        | "RevokeWorkspaceSandboxAuthorization",
      commandPayload: unknown,
    ) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const submission = yield* makeExternalSubmissionFromServices({
                authenticatedHumans: [human],
                directParentOf: [],
              });
              return yield* submission.submit(human, humanContext, {
                commandType,
                commandId: `cmd_${uuid(n)}`,
                projectId,
                actor: human,
                issuedAt: now,
                payload: commandPayload,
              });
            }),
            open(),
          ),
        ),
      );
    expect(
      await send(950, "AuthorizeWorkspaceSandbox", payload()),
    ).toMatchObject({
      ok: true,
      body: {
        resolution: "Committed",
        result: {
          authorization: {
            authorizationRevision: 1,
            state: "Granted",
            origin: { kind: "Human", principal: human },
          },
        },
      },
    });
    const read = () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const queries = yield* ProjectionQueryPort;
              return yield* queries.query("workspace-detail", {
                workspaceId: root,
              });
            }),
            open(),
          ),
        ),
      );
    expect(await read()).toMatchObject({
      value: {
        workspaceSandboxAuthorization: {
          expectedAuthorizationRevision: 1,
          current: { state: "Granted", expiresAt: null },
        },
      },
    });
    expect(
      await send(951, "RevokeWorkspaceSandboxAuthorization", {
        workspaceId: root,
        expectedAuthorizationRevision: 1,
      }),
    ).toMatchObject({
      ok: true,
      body: {
        resolution: "Committed",
        result: {
          authorization: { authorizationRevision: 2, state: "Revoked" },
        },
      },
    });
    expect(await read()).toMatchObject({
      value: {
        workspaceSandboxAuthorization: {
          expectedAuthorizationRevision: 2,
          current: { state: "Revoked" },
        },
      },
    });
    expect(
      await send(952, "AuthorizeWorkspaceSandbox", {
        ...payload(),
        expectedAuthorizationRevision: 2,
      }),
    ).toMatchObject({
      ok: true,
      body: {
        resolution: "Committed",
        result: {
          authorization: { authorizationRevision: 3, state: "Granted" },
        },
      },
    });
  } finally {
    fixture.cleanup();
  }
};
