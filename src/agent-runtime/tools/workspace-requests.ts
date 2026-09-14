import { Schema } from "effect";
import type { ContextPackage } from "../../domain/context-package.js";
import { type Tool, toolFromSchema } from "../tool.js";

/** P1-07A (D-037): agent-side workspace requests — high-level intent only,
 * never direct formal-state mutation (REQUEST_PROJECTION_BRIDGE).
 * Every call is recorded as a transcript `workspace_request` event whose
 * requestId is the idempotency key. `report_completion` hands control to the
 * Runtime-owned finalization (P1-08). */
export function makeWorkspaceRequestTools(deps: {
  readonly pkg: ContextPackage;
  readonly record: (requestType: string, payloadJson: string) => Promise<void>;
  readonly onCompletion: (summary: string) => Promise<string>;
  readonly onCreateChild?:
    | ((req: {
        intent: string;
        responsibility: string;
        deliverables: string;
        writablePrefixes: string[];
      }) => Promise<string>)
    | undefined;
  /** P4-01 (I2): read-only projection of children's effective state. */
  readonly childrenSummary?: string | undefined;
  /** P4-02 (I1): communication hooks, performed by the Runtime. */
  readonly onAsk?:
    | ((req: { target: string; question: string; reason: string }) => Promise<string>)
    | undefined;
  readonly onListInbox?: (() => Promise<string>) | undefined;
  readonly onAnswer?:
    | ((req: { id: string; answer: string; evidence: string }) => Promise<string>)
    | undefined;
}): Tool[] {
  const commTools: Tool[] = [];
  if (deps.onAsk !== undefined) {
    commTools.push(
      toolFromSchema({
        name: "request_information",
        description:
          "Ask another workspace a question through formal communication (routed via the common ancestor). " +
          "Communication carries information only; it never changes engineering state.",
        params: Schema.Struct({
          target: Schema.String,
          question: Schema.String,
          reason: Schema.String,
        }),
        execute: async (p) => {
          await deps.record("request_information", JSON.stringify(p));
          return (deps.onAsk as (x: typeof p) => Promise<string>)(p);
        },
      }),
    );
  }
  if (deps.onListInbox !== undefined) {
    commTools.push(
      toolFromSchema({
        name: "list_inbox",
        description:
          "List this workspace's formal communication inbox (questions from other workspaces).",
        params: Schema.Struct({}),
        execute: async () => (deps.onListInbox as () => Promise<string>)(),
      }),
    );
  }
  if (deps.onAnswer !== undefined) {
    commTools.push(
      toolFromSchema({
        name: "answer_information",
        description: "Answer a question in this workspace's inbox with evidence.",
        params: Schema.Struct({
          id: Schema.String,
          answer: Schema.String,
          evidence: Schema.String,
        }),
        execute: async (p) => {
          await deps.record("answer_information", JSON.stringify(p));
          return (deps.onAnswer as (x: typeof p) => Promise<string>)(p);
        },
      }),
    );
  }
  const createChildTool =
    deps.onCreateChild === undefined
      ? []
      : [
          toolFromSchema({
            name: "request_create_child",
            description:
              "Propose a child workspace for an independent sub-responsibility. writablePrefixes must be inside " +
              "this workspace's writable set and must not overlap sibling workspaces. The runtime validates the " +
              "structure and creates the child if it holds.",
            params: Schema.Struct({
              intent: Schema.String,
              responsibility: Schema.String,
              deliverables: Schema.String,
              writablePrefixes: Schema.Array(Schema.String),
            }),
            execute: async (p) => {
              await deps.record("request_create_child", JSON.stringify(p));
              return (deps.onCreateChild as (req: typeof p) => Promise<string>)(p);
            },
          }),
        ];
  const inspect = toolFromSchema({
    name: "inspect_workspace",
    description:
      "Inspect the current formal workspace state (identity, contract, resources, effective state).",
    params: Schema.Struct({}),
    execute: async () =>
      [
        `project: ${deps.pkg.projectId}`,
        `workspace: ${deps.pkg.workspaceId}`,
        `intent: ${deps.pkg.contract.intent}`,
        `responsibility: ${deps.pkg.contract.responsibility}`,
        `deliverables: ${deps.pkg.contract.deliverables}`,
        `writable: ${deps.pkg.resources.writable.join(", ")}`,
        `effective store revision: ${deps.pkg.effective.storeCommitSha}`,
        ...(deps.childrenSummary !== undefined
          ? ["", "children (read-only projection):", deps.childrenSummary]
          : []),
      ].join("\n"),
  });

  const status = toolFromSchema({
    name: "report_status",
    description: "Report current work status to the workspace runtime.",
    params: Schema.Struct({ status: Schema.String }),
    execute: async (p) => {
      await deps.record("report_status", JSON.stringify(p));
      return "status recorded";
    },
  });

  const blocker = toolFromSchema({
    name: "report_blocker",
    description: "Report a blocker that prevents progress. Describe what is blocked and why.",
    params: Schema.Struct({ blocker: Schema.String }),
    execute: async (p) => {
      await deps.record("report_blocker", JSON.stringify(p));
      return "blocker recorded";
    },
  });

  const completion = toolFromSchema({
    name: "report_completion",
    description:
      "Report that the task is complete. The runtime takes over: prepares an immutable candidate commit, " +
      "runs local verification, and activates the result if it passes. Do not call until the work is done.",
    params: Schema.Struct({ summary: Schema.String }),
    execute: async (p) => {
      await deps.record("report_completion", JSON.stringify(p));
      return deps.onCompletion(p.summary);
    },
  });

  return [inspect, status, blocker, completion, ...createChildTool, ...commTools];
}
