import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProductionFixture } from "./production-fixture.js";
import { startProductionFixture } from "./production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  submitHumanMessage,
  waitForPublic,
} from "./public-client.js";

export interface NativeOwnerReportRequest {
  readonly operationKind: string;
  readonly providerTurnId: string;
  readonly bindingVariant: string;
  readonly items: ReadonlyArray<{
    readonly _tag: string;
    readonly implementation?: string;
    readonly bindingFingerprint?: string;
    readonly opaqueItemRef?: string;
  }>;
}

interface ReportSink {
  readonly url: string;
  readonly requests: NativeOwnerReportRequest[];
  readonly close: () => Promise<void>;
}

interface JobRow {
  readonly state: string;
  readonly response_body: string | null;
  readonly response_execution_id: string | null;
}

interface OwnerRow {
  readonly context_epoch: number;
  readonly checkpoint_kind: string | null;
  readonly checkpoint_ref: string | null;
  readonly binding_fingerprint: string | null;
  readonly source_manifest_json: string | null;
}

const nativeChildEntry = resolve(
  "tests/functional/support/ah19-native-daemon-child.mjs",
);

export const restartNativeConversationDaemon = (
  fixture: ProductionFixture,
  reportUrl: string,
  bindingVariant: "A" | "B",
) =>
  fixture.restart({
    entry: nativeChildEntry,
    daemonEnvironment: {
      ARBOR_AH19_BOUNDARY: "none",
      ARBOR_AH19_BINDING_VARIANT: bindingVariant,
      ARBOR_AH19_REPORT_URL: reportUrl,
      ARBOR_AH19_TERMINAL_CONVERSATION: "1",
    },
  });

const reportSink = async (): Promise<ReportSink> => {
  const requests: NativeOwnerReportRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        requests.push(
          JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as NativeOwnerReportRequest,
        );
        response.writeHead(204);
        response.end();
      } catch (error) {
        response.writeHead(400);
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("AH19 native owner report server did not bind TCP");
  }
  return {
    url: `http://127.0.0.1:${address.port}/requests`,
    requests,
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        server.close((error) =>
          error === undefined ? resolveClose() : rejectClose(error),
        ),
      ),
  };
};

const read = <A>(databaseFile: string, query: (db: DatabaseSync) => A): A => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
};

const responseJob = (
  databaseFile: string,
  messageId: string,
): JobRow | undefined =>
  read(
    databaseFile,
    (db) =>
      db
        .prepare(
          `SELECT state, response_body, response_execution_id
           FROM conversation_response_jobs WHERE message_id = ?`,
        )
        .get(messageId) as JobRow | undefined,
  );

const owner = (
  databaseFile: string,
  workspaceId: string,
): OwnerRow | undefined =>
  read(
    databaseFile,
    (db) =>
      db
        .prepare(
          `SELECT context_epoch, checkpoint_kind, checkpoint_ref,
                binding_fingerprint, source_manifest_json
           FROM conversation_checkpoint_owners WHERE root_workspace_id = ?`,
        )
        .get(workspaceId) as OwnerRow | undefined,
  );

const currentMessageId = (
  databaseFile: string,
  workspaceId: string,
): string | undefined =>
  read(
    databaseFile,
    (db) =>
      (
        db
          .prepare(
            `SELECT message_id FROM human_messages WHERE root_workspace_id = ?
             ORDER BY created_at DESC, message_id DESC LIMIT 1`,
          )
          .get(workspaceId) as { readonly message_id: string } | undefined
      )?.message_id,
  );

export interface NativeOwnerScenario {
  readonly fixture: ProductionFixture;
  readonly report: ReportSink;
  readonly childOutput: string[];
  readonly client: ReturnType<typeof makePublicClient>;
  readonly project: Awaited<ReturnType<typeof createFunctionalProject>>;
  readonly nativeOwner: OwnerRow;
  readonly nativeOpaqueRef: string;
  readonly secondMessageId: string;
}

export const startNativeConversationOwnerScenario =
  async (): Promise<NativeOwnerScenario> => {
    const marker = randomUUID().slice(0, 8);
    const report = await reportSink();
    const childOutput: string[] = [];
    const fixture = await startProductionFixture({
      reply: () => ({ _tag: "Text", text: `AH19_NORMAL_ANSWER_${marker}` }),
      daemonEnvironment: { ARBOR_AH19_REPORT_URL: report.url },
      onDaemonStdout: (line) => childOutput.push(line),
    });
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      `AH19 conversation native owner ${marker}`,
    );
    await submitHumanMessage(client, project, `AH19_NATIVE_PRIOR_${marker}`);
    const firstAnswered = await waitForPublic(
      async () => {
        const id = currentMessageId(
          fixture.databaseFile,
          project.rootWorkspaceId,
        );
        return id === undefined
          ? undefined
          : responseJob(fixture.databaseFile, id);
      },
      (job) => job?.state === "Answered",
      60_000,
    );
    if (firstAnswered?.state !== "Answered") {
      await fixture.stop();
      await report.close();
      throw new Error("initial canonical Conversation response did not answer");
    }

    await fixture.crash();
    await restartNativeConversationDaemon(fixture, report.url, "A");
    await submitHumanMessage(client, project, `AH19_NATIVE_OWNER_${marker}`);
    const secondMessageId = await waitForPublic(
      async () => {
        const id = currentMessageId(
          fixture.databaseFile,
          project.rootWorkspaceId,
        );
        return id !== undefined &&
          owner(fixture.databaseFile, project.rootWorkspaceId)
            ?.checkpoint_kind === "ProviderNative"
          ? id
          : undefined;
      },
      (id) => id !== undefined,
      90_000,
    );
    const nativeOwner = owner(fixture.databaseFile, project.rootWorkspaceId);
    if (
      secondMessageId === undefined ||
      nativeOwner?.checkpoint_kind !== "ProviderNative" ||
      nativeOwner.checkpoint_ref === null ||
      nativeOwner.binding_fingerprint === null
    ) {
      await fixture.stop();
      await report.close();
      throw new Error(
        `Conversation ProviderNative owner was not committed: ${JSON.stringify(nativeOwner)}`,
      );
    }
    await waitForPublic(
      async () => responseJob(fixture.databaseFile, secondMessageId),
      (job) => job?.state === "Answered",
      60_000,
    );
    return {
      fixture,
      report,
      childOutput,
      client,
      project,
      nativeOwner,
      nativeOpaqueRef: nativeOwner.checkpoint_ref,
      secondMessageId,
    };
  };

export const responseJobForLatestMessage = (
  fixture: ProductionFixture,
  workspaceId: string,
): JobRow | undefined => {
  const messageId = currentMessageId(fixture.databaseFile, workspaceId);
  return messageId === undefined
    ? undefined
    : responseJob(fixture.databaseFile, messageId);
};
