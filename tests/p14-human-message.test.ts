import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { makeSubmitHumanMessageHandler } from "../packages/application/src/commands/submit-human-message.js";
import {
  AuthorityResolverPort,
  AuthorityResolverPortLive,
} from "../packages/application/src/index.js";
import {
  Actor,
  type CommandId,
  type CommandSubmissionContext,
  type InboxEntry,
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
} from "../packages/domain/src/index.js";
import {
  type HumanMessageRecord,
  type HumanMessageStoreService,
  type InboxProjectionStoreService,
  TransactionScope,
} from "../packages/ports/src/index.js";

/**
 * P14-001 (contract `01`) — SubmitHumanMessage: durable/idempotent command,
 * root-only exact binding, HumanConversation inbox admission (≠HumanInput),
 * independent HumanMessageSubmitted event (no fabricated senderWorkspaceId).
 *
 * Seams: S1 durability/idempotency, S2 root-only, S3 ≠Steer/≠HumanInput.
 */

const PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const ROOT = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789ab");
const CHILD = parse(WorkspaceId)("ws_118f2b3c-4d5e-7abc-8def-0123456789ab");
const HUMAN = parse(Principal)("user:lgao");
const AGENT = parse(Principal)("agent:worker");

const scopeLayer = Layer.succeed(TransactionScope, {
  session: { id: "test-tx" },
}) as unknown as Layer.Layer<TransactionScope>;

/** Run one handler execution with the TransactionScope stub provided. */
const run = async <A>(
  effect: Effect.Effect<A, unknown, TransactionScope>,
): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, scopeLayer) as Effect.Effect<A>);

const envelope = (args: {
  readonly messageId: string;
  readonly targetWorkspaceId: string;
  readonly bodyRef: string;
  readonly commandId?: string;
}) =>
  ({
    commandType: "SubmitHumanMessage",
    commandId: (args.commandId ?? "cmd_p14_0001") as CommandId,
    projectId: PROJECT,
    actor: parse(Actor)("user:lgao"),
    issuedAt: "2026-09-23T05:00:00.000Z",
    payload: {
      messageId: args.messageId,
      targetWorkspaceId: args.targetWorkspaceId,
      bodyRef: args.bodyRef,
    },
  }) as never;

const externalContext = (principal: Principal): CommandSubmissionContext => ({
  _tag: "External",
  principal,
});

interface Harness {
  readonly handler: ReturnType<typeof makeSubmitHumanMessageHandler>;
  readonly rows: Map<string, HumanMessageRecord>;
  readonly inbox: Array<InboxEntry>;
}

const makeHarness = (): Harness => {
  const rows = new Map<string, HumanMessageRecord>();
  const inbox: Array<InboxEntry> = [];
  const messages: Pick<HumanMessageStoreService, "insertPending" | "findById"> =
    {
      insertPending: (record) => {
        const existing = rows.get(record.messageId);
        if (existing !== undefined) {
          return Effect.fail({
            _tag: "HumanMessageConflict" as const,
            existing,
          });
        }
        rows.set(record.messageId, record);
        return Effect.void;
      },
      findById: (messageId) =>
        Effect.succeed(
          rows.has(messageId)
            ? Option.some(rows.get(messageId) as HumanMessageRecord)
            : Option.none(),
        ),
    };
  const inboxStore: Pick<InboxProjectionStoreService, "admitUpsert"> = {
    admitUpsert: (entry) => {
      inbox.push(entry);
      return Effect.void;
    },
  };
  const handler = makeSubmitHumanMessageHandler({
    messages,
    inbox: inboxStore,
    rootWorkspaceOf: () => ROOT,
  });
  return { handler, rows, inbox };
};

let harness: Harness;

beforeEach(() => {
  harness = makeHarness();
});

const submit = (
  target: Harness,
  args: Parameters<typeof envelope>[0],
  principal: Principal = HUMAN,
) =>
  run(
    target.handler.execute(envelope(args), externalContext(principal)) as never,
  );

describe("P14-001 SubmitHumanMessage", () => {
  it("S2: accepts an authenticated human targeting the root workspace", async () => {
    const outcome = (await submit(harness, {
      messageId: "msg_0001",
      targetWorkspaceId: ROOT,
      bodyRef: "请帮我规划下一阶段",
    })) as never as {
      ok: boolean;
      value: {
        result: { state: string };
        events: ReadonlyArray<{ eventType: string }>;
      };
    };
    expect(outcome.ok).toBe(true);
    expect(outcome.value.result.state).toBe("Pending");
    expect(outcome.value.events).toHaveLength(1);
    expect(outcome.value.events[0]?.eventType).toBe("HumanMessageSubmitted");
  });

  it("S2: rejects a non-root target (child direct-chat closed at handler level)", async () => {
    const outcome = (await submit(harness, {
      messageId: "msg_0002",
      targetWorkspaceId: CHILD,
      bodyRef: "child?",
    })) as never as { ok: boolean; error: { _tag: string } };
    expect(outcome.ok).toBe(false);
    expect(outcome.error._tag).toBe("AuthorityDenied");
    expect(harness.rows.size).toBe(0);
    expect(harness.inbox).toHaveLength(0);
  });

  it("S2: human-ness is the resolver's job — the handler trusts the authenticated context", () => {
    // The handler deliberately does NOT re-decide human-ness (governance
    // facts may list principals without a `user:` prefix); the resolver's
    // isAuthenticatedHuman is the single authority. The agent-negative case
    // is asserted at the resolver level below.
    expect(harness.handler.stopAdmission).toEqual({ _tag: "Unclassified" });
  });

  it("S1+S3: durable Pending row + HumanConversation inbox admission (≠HumanInput)", async () => {
    await submit(harness, {
      messageId: "msg_0004",
      targetWorkspaceId: ROOT,
      bodyRef: "正文",
    });
    const row = harness.rows.get("msg_0004");
    expect(row?.state).toBe("Pending");
    expect(row?.humanPrincipal).toBe(HUMAN);
    expect(row?.bodyRef).toBe("正文");
    const entry = harness.inbox[0];
    expect(entry?.kind).toBe("HumanConversation");
    expect(entry?.kind).not.toBe("HumanInput");
    expect(entry?.entryKey).toBe("humanmsg:msg_0004");
    expect(entry?.recipientWorkspaceId).toBe(ROOT);
  });

  it("S1: same messageId + same fingerprint converges (idempotent, one row, no extra event)", async () => {
    const args = {
      messageId: "msg_0005",
      targetWorkspaceId: ROOT,
      bodyRef: "同一条消息",
    };
    await submit(harness, args);
    const second = (await submit(harness, {
      ...args,
      commandId: "cmd_p14_0002",
    })) as never as {
      ok: boolean;
      value: { events: ReadonlyArray<unknown> };
    };
    expect(second.ok).toBe(true);
    expect(second.value.events).toHaveLength(0);
    expect(harness.rows.size).toBe(1);
  });

  it("S1: same messageId + different body rejects with IdempotencyConflict", async () => {
    await submit(harness, {
      messageId: "msg_0006",
      targetWorkspaceId: ROOT,
      bodyRef: "原消息",
    });
    const conflict = (await submit(harness, {
      messageId: "msg_0006",
      targetWorkspaceId: ROOT,
      bodyRef: "改了内容",
      commandId: "cmd_p14_0003",
    })) as never as { ok: boolean; error: { _tag: string } };
    expect(conflict.ok).toBe(false);
    expect(conflict.error._tag).toBe("IdempotencyConflict");
    expect(harness.rows.size).toBe(1);
  });

  it("S3: event carries humanPrincipal and never a senderWorkspaceId", async () => {
    const outcome = (await submit(harness, {
      messageId: "msg_0007",
      targetWorkspaceId: ROOT,
      bodyRef: "事件形状",
    })) as never as {
      ok: boolean;
      value: { events: ReadonlyArray<{ payload: Record<string, unknown> }> };
    };
    expect(outcome.ok).toBe(true);
    const payload = outcome.value.events[0]?.payload ?? {};
    expect(payload.humanPrincipal).toBe(HUMAN);
    expect("senderWorkspaceId" in payload).toBe(false);
    expect(payload.rootWorkspaceId).toBe(ROOT);
  });

  it("S3: no Work/Steer artifacts (single HumanMessageSubmitted event)", async () => {
    const outcome = (await submit(harness, {
      messageId: "msg_0008",
      targetWorkspaceId: ROOT,
      bodyRef: "无 steer 语义",
    })) as never as {
      ok: boolean;
      value: { events: ReadonlyArray<{ eventType: string }> };
    };
    expect(outcome.ok).toBe(true);
    const eventTypes = outcome.value.events.map((event) => event.eventType);
    expect(eventTypes).toEqual(["HumanMessageSubmitted"]);
    expect(eventTypes).not.toContain("WorkSteered");
    expect(eventTypes).not.toContain("HumanInterventionApplied");
  });

  it("rejects an empty bodyRef with ResourceExhausted", async () => {
    const outcome = (await submit(harness, {
      messageId: "msg_0009",
      targetWorkspaceId: ROOT,
      bodyRef: "",
    })) as never as { ok: boolean; error: { _tag: string } };
    expect(outcome.ok).toBe(false);
    expect(outcome.error._tag).toBe("ResourceExhausted");
  });
});

/**
 * P14 `01` §1 — resolver-level root-only + human enforcement (the authority
 * layer; mirrors the P12 authority-resolver harness). Seam S2.
 */
const decisionInput = (
  principal: Principal,
  payload: Record<string, unknown>,
): never =>
  ({
    principal,
    submissionContext: { _tag: "External", principal },
    envelope: {
      commandType: "SubmitHumanMessage",
      commandId: "cmd_p14_resolve_1",
      projectId: PROJECT,
      actor: parse(Actor)("user:lgao"),
      issuedAt: "2026-09-23T05:00:00.000Z",
      payload,
    },
    semanticRequestFingerprint: "fingerprint-p14",
    canonicalFacts: {
      projectId: PROJECT,
      project: { rootWorkspaceId: ROOT },
      workspace: {
        workspaceId: ROOT,
        projectId: PROJECT,
        parentWorkspaceId: null,
      },
    },
    grants: [],
    governance: { authenticatedHumans: [], directParentOf: [] },
    policy: {},
  }) as never;

const resolveError = (input: never): Promise<{ _tag: string }> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const resolver = yield* AuthorityResolverPort;
        return yield* Effect.flip(resolver.resolve(input));
      }) as unknown as Effect.Effect<
        { _tag: string },
        never,
        AuthorityResolverPort
      >,
      AuthorityResolverPortLive,
    ),
  );

describe("P14-001 resolver root-only exact binding (seam S2)", () => {
  it("user: principal + root target resolves to SubmitHumanMessageAuthority", async () => {
    const fact = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const resolver = yield* AuthorityResolverPort;
          return yield* resolver.resolve(
            decisionInput(HUMAN, {
              messageId: "msg_resolve_1",
              targetWorkspaceId: ROOT,
              bodyRef: "hi",
            }),
          );
        }) as unknown as Effect.Effect<
          { readonly _tag: string; readonly targetWorkspaceId: string },
          never,
          AuthorityResolverPort
        >,
        AuthorityResolverPortLive,
      ),
    );
    expect(fact._tag).toBe("SubmitHumanMessageAuthority");
    expect(fact.targetWorkspaceId).toBe(ROOT);
  });

  it("child target is denied (root-only override rule)", async () => {
    const error = await resolveError(
      decisionInput(HUMAN, {
        messageId: "msg_resolve_2",
        targetWorkspaceId: CHILD,
        bodyRef: "hi child",
      }),
    );
    expect(error._tag).toBe("GovernanceOverrideDenied");
  });

  it("agent principal is denied (existing governance denial path)", async () => {
    const error = await resolveError(
      decisionInput(AGENT, {
        messageId: "msg_resolve_3",
        targetWorkspaceId: ROOT,
        bodyRef: "agent",
      }),
    );
    expect(error._tag).toBe("NoApplicableGrant");
  });
});
