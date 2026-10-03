import type { ModelFacingControlToolDefinition } from "@arbor/ports";

const fnv = (input: string): string => {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
};

const WAIT_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    reason: { type: "string", minLength: 1 },
    waitSpec: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "conditions"],
      properties: {
        mode: { const: "Any" },
        conditions: {
          type: "array",
          minItems: 1,
          items: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["_tag", "dependencyId", "observedRevision"],
                properties: {
                  _tag: { const: "DependencyChanged" },
                  dependencyId: { type: "string", pattern: "^dep_" },
                  observedRevision: { type: "integer", minimum: 0 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["_tag", "decisionId", "observedRevision"],
                properties: {
                  _tag: { const: "DecisionChanged" },
                  decisionId: { type: "string", pattern: "^dec_" },
                  observedRevision: { type: "integer", minimum: 0 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["_tag", "workId", "targetWorkRevision"],
                properties: {
                  _tag: { const: "VerificationChanged" },
                  workId: { type: "string", pattern: "^wrk_" },
                  targetWorkRevision: { type: "integer", minimum: 0 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["_tag", "workspaceId", "observedSequence"],
                properties: {
                  _tag: { const: "InboxAdvanced" },
                  workspaceId: { type: "string", pattern: "^ws_" },
                  observedSequence: { type: "integer", minimum: 0 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["_tag", "environmentRef", "observedRevision"],
                properties: {
                  _tag: { const: "EnvironmentChanged" },
                  environmentRef: { type: "string", minLength: 1 },
                  observedRevision: { type: "string", minLength: 1 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["_tag", "instant"],
                properties: {
                  _tag: { const: "TimeReached" },
                  instant: { type: "string", format: "date-time" },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["_tag"],
                properties: { _tag: { const: "Manual" } },
              },
            ],
          },
        },
      },
    },
  },
  required: ["reason", "waitSpec"],
});

const SEND_MESSAGE_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      enum: ["Query", "Reply", "Report", "DecisionRequest"],
    },
    body: { type: "string", minLength: 1 },
    recipientWorkspaceId: { type: "string", minLength: 1 },
    queryMessageId: { type: "string", minLength: 1 },
  },
  required: ["kind", "body"],
});

const CLAIM_COMPLETION_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    claim: {
      type: "string",
      minLength: 1,
      description:
        "Why the Work is complete: what was produced and how it satisfies the completion expectation.",
    },
  },
  required: ["claim"],
});

const ASSIGN_WORK_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: [
    "objective",
    "why",
    "constraints",
    "completionExpectation",
    "verificationMission",
    "reason",
  ],
  properties: {
    targetWorkspaceRef: {
      type: "string",
      minLength: 1,
      description:
        "Omit for the current Workspace; otherwise use an opaque ref returned by list_workspaces/read_workspace.",
    },
    objective: { type: "string", minLength: 1 },
    why: { type: "string", minLength: 1 },
    constraints: { type: "array", items: { type: "string" } },
    completionExpectation: { type: "string", minLength: 1 },
    reason: {
      type: "string",
      minLength: 1,
      description: "Why this Work is being assigned now.",
    },
    verificationMission: {
      type: "object",
      additionalProperties: false,
      required: ["goal", "criteria", "riskRequirements"],
      properties: {
        goal: { type: "string", minLength: 1 },
        criteria: {
          type: "array",
          minItems: 1,
          contains: {
            type: "object",
            required: ["required"],
            properties: { required: { const: true } },
          },
          items: {
            type: "object",
            additionalProperties: false,
            required: ["criterionId", "requirement", "required"],
            properties: {
              criterionId: { type: "string", minLength: 1 },
              requirement: { type: "string", minLength: 1 },
              required: { type: "boolean" },
            },
          },
        },
        riskRequirements: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  },
});

const LIST_WORKSPACES_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", minLength: 1 },
    query: { type: "string", minLength: 1 },
  },
});

const READ_WORKSPACE_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["workspaceRef"],
  properties: {
    workspaceRef: { type: "string", minLength: 1 },
  },
});

const ACCEPT_RESULT_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["resultRef"],
  properties: {
    resultRef: { type: "string", pattern: "^rref_" },
  },
});

const UPDATE_PLAN_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["itemId", "text", "status"],
        properties: {
          itemId: { type: "string", minLength: 1 },
          text: { type: "string", minLength: 1 },
          status: {
            enum: ["Pending", "InProgress", "Completed", "Blocked"],
          },
        },
      },
    },
  },
});

const SELECT_CURRENT_WORK_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["workId"],
  properties: {
    workId: { type: "string", pattern: "^wrk_" },
  },
});

const PROPOSE_CHILD_WORKSPACE_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description: "Stable short name for the proposed child workspace.",
    },
    rationale: {
      type: "string",
      minLength: 1,
      description:
        "Why this responsibility should be a long-lived child workspace rather than local work.",
    },
    responsibilityDraft: {
      type: "object",
      additionalProperties: false,
      required: ["purpose"],
      properties: {
        purpose: { type: "string", minLength: 1 },
        ownedResponsibilities: { type: "array", items: { type: "string" } },
        obligations: { type: "array", items: { type: "string" } },
        includes: { type: "array", items: { type: "string" } },
        excludes: { type: "array", items: { type: "string" } },
        interfaces: { type: "array", items: { type: "string" } },
      },
    },
    resourceBoundaryDraft: {
      type: "object",
      additionalProperties: false,
      required: ["addresses"],
      properties: {
        addresses: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["_tag", "path"],
            properties: {
              _tag: { enum: ["FileTree", "GitWorktree"] },
              path: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
    initialWork: {
      type: "object",
      additionalProperties: false,
      required: [
        "objective",
        "why",
        "constraints",
        "completionExpectation",
        "verificationMission",
      ],
      properties: {
        objective: { type: "string", minLength: 1 },
        why: { type: "string", minLength: 1 },
        constraints: { type: "array", items: { type: "string" } },
        completionExpectation: { type: "string", minLength: 1 },
        verificationMission: {
          type: "object",
          additionalProperties: false,
          required: ["goal", "criteria", "riskRequirements"],
          properties: {
            goal: { type: "string", minLength: 1 },
            criteria: {
              type: "array",
              minItems: 1,
              contains: {
                type: "object",
                required: ["required"],
                properties: { required: { const: true } },
              },
              items: {
                type: "object",
                additionalProperties: false,
                required: ["criterionId", "requirement", "required"],
                properties: {
                  criterionId: { type: "string", minLength: 1 },
                  requirement: { type: "string", minLength: 1 },
                  required: { type: "boolean" },
                },
              },
            },
            riskRequirements: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
    },
  },
  required: [
    "name",
    "rationale",
    "responsibilityDraft",
    "resourceBoundaryDraft",
  ],
});

const SPAWN_SPECIALIST_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    mission: {
      type: "string",
      minLength: 1,
      description:
        "The bounded, specialist-only subtask for the temporary execution.",
    },
    constraints: {
      type: "array",
      items: { type: "string" },
      description: "Optional constraints the specialist must respect.",
    },
  },
  required: ["mission"],
});

const DECLARE_DEPENDENCY_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    producerBinding: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["_tag"],
          properties: { _tag: { const: "AnyProducer" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["_tag", "workspaceId"],
          properties: {
            _tag: { const: "WorkspaceBound" },
            workspaceId: { type: "string", pattern: "^ws_" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["_tag", "workId"],
          properties: {
            _tag: { const: "WorkBound" },
            workId: { type: "string", pattern: "^wrk_" },
          },
        },
      ],
    },
    expectedDeliverable: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "requiredArtifactRoles"],
      properties: {
        kind: { type: "string", minLength: 1 },
        requiredArtifactRoles: { type: "array", items: { type: "string" } },
      },
    },
  },
  required: ["producerBinding", "expectedDeliverable"],
});

const PRODUCE_DELIVERABLE_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["kind", "artifacts"],
  properties: {
    kind: { type: "string", minLength: 1 },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "artifactId"],
        properties: {
          role: { type: "string", minLength: 1 },
          artifactId: { type: "string", pattern: "^art_" },
        },
      },
    },
  },
});

const DELIVER_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["deliverableId", "summary"],
  properties: {
    deliverableId: { type: "string", pattern: "^del_" },
    summary: { type: "string", minLength: 1, maxLength: 4096 },
  },
});

const RECORD_VERIFICATION_EVIDENCE_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["criterionId", "sourceCallRef"],
  properties: {
    criterionId: { type: "string", minLength: 1 },
    sourceCallRef: {
      type: "string",
      minLength: 1,
      description:
        "Selector for a successful executable ToolResult visible in this verifier session: copy its exact callRef, or use a newest-first ordinal ('1' = most recent). Runtime binds canonical identity.",
    },
  },
});

const CONCLUDE_VERIFICATION_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "criteriaResults", "summary"],
  properties: {
    verdict: { enum: ["Pass", "Fail", "Unknown"] },
    criteriaResults: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "criterionId",
          "requirement",
          "required",
          "verdict",
          "evidenceRefs",
        ],
        properties: {
          criterionId: { type: "string", minLength: 1 },
          requirement: { type: "string", minLength: 1 },
          required: { type: "boolean" },
          verdict: { enum: ["Pass", "Fail", "Unknown"] },
          evidenceRefs: {
            type: "array",
            minItems: 1,
            items: { type: "string", pattern: "^evd_" },
          },
        },
      },
    },
    summary: { type: "string", minLength: 1 },
  },
});

export const controlToolDefinitions =
  (): ReadonlyArray<ModelFacingControlToolDefinition> => {
    const raw = [
      {
        stableId: "core.control.wait",
        name: "wait",
        description:
          "Register a durable wait condition and settle this execution.",
        schemaJson: WAIT_SCHEMA,
        version: "2",
        requiredCapability: "agent:wait",
        legacyNames: [{ name: "arbor_wait", version: "1", hash: "3c84373e" }],
      },
      {
        stableId: "core.control.send-message",
        name: "send_message",
        description:
          "Send a durable coordination message through the owning workspace.",
        schemaJson: SEND_MESSAGE_SCHEMA,
        version: "2",
        requiredCapability: "agent:communicate",
        legacyNames: [
          { name: "arbor_send_message", version: "1", hash: "6fe7259a" },
        ],
      },
      {
        stableId: "core.control.assign-work",
        name: "assign_work",
        description:
          "Assign a new bounded Work outcome to the current Workspace or one of its direct child Workspaces. Runtime binds identity, revisions, authority, and predecessor provenance.",
        schemaJson: ASSIGN_WORK_SCHEMA,
        version: "1",
        requiredCapability: "agent:assign-work",
        legacyNames: [],
      },
      {
        stableId: "core.control.list-workspaces",
        name: "list_workspaces",
        description:
          "List the current Workspace, active direct children, and in-flight formation summaries using scoped opaque refs.",
        schemaJson: LIST_WORKSPACES_SCHEMA,
        version: "1",
        requiredCapability: "agent:inspect-workspaces",
        legacyNames: [],
      },
      {
        stableId: "core.control.read-workspace",
        name: "read_workspace",
        description:
          "Read one current/direct-child Workspace responsibility and open-work summary by scoped opaque ref.",
        schemaJson: READ_WORKSPACE_SCHEMA,
        version: "1",
        requiredCapability: "agent:inspect-workspaces",
        legacyNames: [],
      },
      {
        stableId: "core.control.accept-result",
        name: "accept_result",
        description:
          "Accept one exact PASS result from an active direct-child Workspace using a scoped result ref. Runtime binds Work, revision and Verification identities.",
        schemaJson: ACCEPT_RESULT_SCHEMA,
        version: "1",
        requiredCapability: "agent:accept-result",
        legacyNames: [],
      },
      {
        stableId: "core.control.select-current-work",
        name: "select_current_work",
        description:
          "Select one candidate Work for the exact WorkSelection DecisionRequest bound to this execution.",
        schemaJson: SELECT_CURRENT_WORK_SCHEMA,
        version: "1",
        requiredCapability: "agent:select-work",
        legacyNames: [],
      },
      {
        stableId: "core.control.update-plan",
        name: "update_plan",
        description:
          "Create or revise the current Work plan. This records progress only; it does not execute steps or complete the Work.",
        schemaJson: UPDATE_PLAN_SCHEMA,
        version: "1",
        requiredCapability: "agent:plan",
        legacyNames: [],
      },
      {
        stableId: "core.control.claim-completion",
        name: "claim_completion",
        description:
          "Claim that the current Work is complete. The claim triggers independent verification; the Work itself is not completed by this action.",
        schemaJson: CLAIM_COMPLETION_SCHEMA,
        version: "2",
        requiredCapability: "agent:claim-completion",
        legacyNames: [
          {
            name: "arbor_claim_completion",
            version: "1",
            hash: "5d210f30",
          },
        ],
      },
      {
        stableId: "core.control.propose-workspace",
        name: "propose_workspace",
        description:
          "Propose a durable child workspace for an independent long-lived responsibility. A human governance decision (Approve/Reject/Modify) is required before the child is created.",
        schemaJson: PROPOSE_CHILD_WORKSPACE_SCHEMA,
        version: "2",
        requiredCapability: "agent:formation",
        legacyNames: [
          {
            name: "arbor_propose_child_workspace",
            version: "1",
            hash: "cae6dfcc",
          },
        ],
      },
      {
        stableId: "core.control.spawn-specialist",
        name: "spawn_specialist",
        description:
          "Spawn a temporary specialist execution for one bounded subtask. It ends with its execution and never creates a durable workspace or responsibility.",
        schemaJson: SPAWN_SPECIALIST_SCHEMA,
        version: "2",
        requiredCapability: "agent:delegate",
        legacyNames: [
          {
            name: "arbor_spawn_specialist",
            version: "1",
            hash: "9d7747cc",
          },
        ],
      },
      {
        stableId: "core.control.declare-dependency",
        name: "declare_dependency",
        description:
          "Declare that the current Work consumes an expected deliverable. Only the deterministic runtime matcher can later satisfy the dependency — declaring it never asserts satisfaction.",
        schemaJson: DECLARE_DEPENDENCY_SCHEMA,
        version: "2",
        requiredCapability: "agent:dependency",
        legacyNames: [
          {
            name: "arbor_declare_dependency",
            version: "1",
            hash: "f796095a",
          },
        ],
      },
      {
        stableId: "core.control.produce-deliverable",
        name: "produce_deliverable",
        description:
          "Record a formal deliverable from the exact current Work revision and versioned Artifact refs. This does not verify quality.",
        schemaJson: PRODUCE_DELIVERABLE_SCHEMA,
        version: "1",
        requiredCapability: "agent:produce-deliverable",
        legacyNames: [],
      },
      {
        stableId: "core.control.deliver",
        name: "deliver",
        description:
          "Deliver an existing formal deliverable from the current child Workspace to its direct parent. Delivery does not itself satisfy quality or acceptance.",
        schemaJson: DELIVER_SCHEMA,
        version: "1",
        requiredCapability: "agent:deliver",
        legacyNames: [],
      },
      {
        stableId: "core.control.record-verification-evidence",
        name: "record_verification_evidence",
        description:
          "Bind a visible executable ToolResult as evidence for one verification criterion. Canonical source identity is resolved by Runtime.",
        schemaJson: RECORD_VERIFICATION_EVIDENCE_SCHEMA,
        version: "2",
        requiredCapability: "agent:verify",
        legacyNames: [
          {
            name: "arbor_record_verification_evidence",
            version: "1",
            hash: "d40aabca",
          },
        ],
      },
      {
        stableId: "core.control.conclude-verification",
        name: "conclude_verification",
        description:
          "Conclude the exact Verification bound to this verifier execution. Runtime stores summary content and submits its BlobRef.",
        schemaJson: CONCLUDE_VERIFICATION_SCHEMA,
        version: "2",
        requiredCapability: "agent:verify",
        legacyNames: [
          {
            name: "arbor_conclude_verification",
            version: "1",
            hash: "45e7af3c",
          },
        ],
      },
    ] as const;
    return raw.map((tool) => ({
      ...tool,
      hash: fnv(JSON.stringify(tool)),
    }));
  };
