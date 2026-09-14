import { Schema } from "effect";

/** D-045: the API is a declared contract. Every endpoint's input and output is
 * an Effect Schema (same tech as the domain layer). The HTTP layer is a pure
 * executor over this table; the SDK derives its types from the same schemas;
 * /api/openapi.json is derived, not hand-written. Clients (web now; tui/app
 * later) consume the SDK only — never ad-hoc fetch calls. */

export const ProjectInitIn = Schema.Struct({
  repoPath: Schema.String,
  home: Schema.optional(Schema.String),
});
export const ProjectInitOut = Schema.Struct({
  projectId: Schema.String,
  workspaceId: Schema.String,
  effectiveRefSha: Schema.String,
});

export const TreeIn = Schema.Struct({
  projectId: Schema.String,
  home: Schema.optional(Schema.String),
});
export const TreeOut = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      workspaceId: Schema.String,
      parentId: Schema.optional(Schema.String),
      kind: Schema.String,
      writablePrefixes: Schema.Array(Schema.String),
      effective: Schema.String,
    }),
  ),
  milestone: Schema.optional(
    Schema.Struct({ n: Schema.Number, rootCommit: Schema.String, summary: Schema.String }),
  ),
});

export const AgentRunIn = Schema.Struct({
  projectId: Schema.String,
  home: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
  task: Schema.optional(Schema.String),
});
export const AgentRunOut = Schema.Struct({
  pid: Schema.Number,
  agentId: Schema.String,
});

export const EventsIn = Schema.Struct({
  since: Schema.Number,
  home: Schema.optional(Schema.String),
  agentId: Schema.String, // path param
});
export const EventsOut = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      sequence: Schema.Number,
      type: Schema.String,
      timestamp: Schema.String,
      text: Schema.optional(Schema.String), // user_input
      content: Schema.optional(Schema.String), // model turn text
      toolCalls: Schema.optional(
        Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, arguments: Schema.String })),
      ),
      callId: Schema.optional(Schema.String), // tool results
      output: Schema.optional(Schema.String),
    }),
  ),
  lastSeq: Schema.Number,
});

export const AcceptIn = Schema.Struct({
  projectId: Schema.String,
  home: Schema.optional(Schema.String),
  workspaceId: Schema.String, // path param
});
export const AcceptOut = Schema.Struct({
  status: Schema.String,
  detail: Schema.optional(Schema.String),
  mergedCommit: Schema.optional(Schema.String),
  invalidated: Schema.optional(Schema.Array(Schema.String)),
});

export const ApprovalsOut = Schema.Struct({
  approvals: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      childWorkspaceId: Schema.String,
      materials: Schema.String,
    }),
  ),
});
export const ApprovalDecideIn = Schema.Struct({
  projectId: Schema.String,
  home: Schema.optional(Schema.String),
  approve: Schema.Boolean,
  note: Schema.optional(Schema.String),
  id: Schema.String, // path param
});
export const ApprovalDecideOut = Schema.Struct({
  status: Schema.String,
  continued: Schema.optional(Schema.String),
});

export const MilestoneIn = Schema.Struct({
  projectId: Schema.String,
  home: Schema.optional(Schema.String),
  summary: Schema.String,
});
export const MilestoneOut = Schema.Struct({ n: Schema.Number, rootCommit: Schema.String });

export interface ApiEndpoint {
  readonly method: "GET" | "POST";
  readonly path: string; // :param placeholders
  readonly in: Schema.Schema<unknown>;
  readonly out: Schema.Schema<unknown>;
  readonly summary: string;
}

export const ProjectsOut = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      sourceRepoPath: Schema.String,
      createdAt: Schema.String,
      hasTree: Schema.Boolean,
    }),
  ),
});

export const API: ReadonlyArray<ApiEndpoint> = [
  { method: "GET", path: "/api/projects", in: Schema.Struct({}) as unknown as Schema.Schema<unknown>, out: ProjectsOut as unknown as Schema.Schema<unknown>, summary: "list runtime projects under the server home" },
  { method: "POST", path: "/api/projects", in: ProjectInitIn as unknown as Schema.Schema<unknown>, out: ProjectInitOut as unknown as Schema.Schema<unknown>, summary: "initialize a runtime project" },
  { method: "GET", path: "/api/tree", in: TreeIn as unknown as Schema.Schema<unknown>, out: TreeOut as unknown as Schema.Schema<unknown>, summary: "engineering tree + milestone" },
  { method: "POST", path: "/api/agent/runs", in: AgentRunIn as unknown as Schema.Schema<unknown>, out: AgentRunOut as unknown as Schema.Schema<unknown>, summary: "start an agent run (spawned child process)" },
  { method: "GET", path: "/api/agents/:agentId/events", in: EventsIn as unknown as Schema.Schema<unknown>, out: EventsOut as unknown as Schema.Schema<unknown>, summary: "incremental transcript events since a sequence" },
  { method: "POST", path: "/api/workspaces/:workspaceId/accept", in: AcceptIn as unknown as Schema.Schema<unknown>, out: AcceptOut as unknown as Schema.Schema<unknown>, summary: "boundary + promotion (approval-gated)" },
  { method: "GET", path: "/api/approvals", in: TreeIn as unknown as Schema.Schema<unknown>, out: ApprovalsOut as unknown as Schema.Schema<unknown>, summary: "list approvals" },
  { method: "POST", path: "/api/approvals/:id", in: ApprovalDecideIn as unknown as Schema.Schema<unknown>, out: ApprovalDecideOut as unknown as Schema.Schema<unknown>, summary: "decide an approval; approve continues the acceptance" },
  { method: "POST", path: "/api/milestones", in: MilestoneIn as unknown as Schema.Schema<unknown>, out: MilestoneOut as unknown as Schema.Schema<unknown>, summary: "fix a milestone stage" },
];

/** Derived, not hand-written. */
export function openapiManifest(): object {
  return {
    openapi: "arbor-contract-v1",
    endpoints: API.map((e) => ({
      method: e.method,
      path: e.path,
      summary: e.summary,
    })),
  };
}
