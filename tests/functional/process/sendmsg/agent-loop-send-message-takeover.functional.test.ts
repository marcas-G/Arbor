import { describe, it } from "vitest";
import { ah10SendMsgTakeOverDecisionRequest } from "./phases-decision-takeover.js";
import { ah10SendMsgRecoverReceiptState } from "./phases-message-receipt-state.js";
import { ah10SendMsgTakeOverQuery } from "./phases-query-takeover.js";
import { ah10SendMsgReplyScenario } from "./phases-reply-seed.js";
import { ah10SendMsgReplyTakeover } from "./phases-reply-takeover.js";

describe("real daemon SendMessage generation takeover", () => {
  it.each([
    { kind: "Query", crashSide: "committed" },
    { kind: "DecisionRequest", crashSide: "committed" },
    { kind: "Report", crashSide: "before" },
    { kind: "Report", crashSide: "after" },
    { kind: "Report", crashSide: "committed" },
  ] as const)(
    "recovers SendMessage($kind) with gen0 $crashSide receipt state",
    async ({ kind, crashSide }) => {
      await ah10SendMsgRecoverReceiptState({ kind, crashSide });
    },
    180_000,
  );

  it.each(["before", "after"] as const)(
    "takes over a Query after killing gen0 %s its FencingRejected receipt commits",
    async (crashSide) => {
      await ah10SendMsgTakeOverQuery(crashSide);
    },
    180_000,
  );

  it.each(["before", "after", "committed"] as const)(
    "recovers a Reply after gen0 %s its Gateway transaction",
    async (crashSide) => {
      const s = await ah10SendMsgReplyScenario(crashSide);
      await ah10SendMsgReplyTakeover(s);
    },
    180_000,
  );

  it.each(["before", "after"] as const)(
    "takes over a DecisionRequest after killing gen0 %s its FencingRejected receipt commits",
    async (crashSide) => {
      await ah10SendMsgTakeOverDecisionRequest(crashSide);
    },
    120_000,
  );
});
