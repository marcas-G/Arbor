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
        "callRef of a successful executable ToolResult visible in this verifier session; Runtime binds its canonical identity.",
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
        name: "arbor_wait",
        description:
          "Register a durable wait condition and settle this execution.",
        schemaJson: WAIT_SCHEMA,
        version: "1",
        requiredCapability: "agent:wait",
      },
      {
        name: "arbor_send_message",
        description:
          "Send a durable coordination message through the owning workspace.",
        schemaJson: SEND_MESSAGE_SCHEMA,
        version: "1",
        requiredCapability: "agent:communicate",
      },
      {
        name: "arbor_claim_completion",
        description:
          "Claim that the current Work is complete. The claim triggers independent verification; the Work itself is not completed by this action.",
        schemaJson: CLAIM_COMPLETION_SCHEMA,
        version: "1",
        requiredCapability: "agent:claim-completion",
      },
      {
        name: "arbor_propose_child_workspace",
        description:
          "Propose a durable child workspace for an independent long-lived responsibility. A human governance decision (Approve/Reject/Modify) is required before the child is created.",
        schemaJson: PROPOSE_CHILD_WORKSPACE_SCHEMA,
        version: "1",
        requiredCapability: "agent:formation",
      },
      {
        name: "arbor_spawn_specialist",
        description:
          "Spawn a temporary specialist execution for one bounded subtask. It ends with its execution and never creates a durable workspace or responsibility.",
        schemaJson: SPAWN_SPECIALIST_SCHEMA,
        version: "1",
        requiredCapability: "agent:delegate",
      },
      {
        name: "arbor_declare_dependency",
        description:
          "Declare that the current Work consumes an expected deliverable. Only the deterministic runtime matcher can later satisfy the dependency — declaring it never asserts satisfaction.",
        schemaJson: DECLARE_DEPENDENCY_SCHEMA,
        version: "1",
        requiredCapability: "agent:dependency",
      },
      {
        name: "arbor_record_verification_evidence",
        description:
          "Bind a visible executable ToolResult as evidence for one verification criterion. Canonical source identity is resolved by Runtime.",
        schemaJson: RECORD_VERIFICATION_EVIDENCE_SCHEMA,
        version: "1",
        requiredCapability: "agent:verify",
      },
      {
        name: "arbor_conclude_verification",
        description:
          "Conclude the exact Verification bound to this verifier execution. Runtime stores summary content and submits its BlobRef.",
        schemaJson: CONCLUDE_VERIFICATION_SCHEMA,
        version: "1",
        requiredCapability: "agent:verify",
      },
    ] as const;
    return raw.map((tool) => ({
      ...tool,
      hash: fnv(JSON.stringify(tool)),
    }));
  };
