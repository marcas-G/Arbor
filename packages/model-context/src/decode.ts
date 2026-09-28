import type { WaitSpec } from "@arbor/domain";
import type {
  CanonicalProviderEvent,
  ProviderFinishReason,
  ProviderTurnId,
} from "@arbor/ports";

/** Legacy semantic vocabulary retained for historical callers only. Provider
 * decoding no longer constructs these values. */
export type AgentDirective =
  | {
      readonly _tag: "InvokeTool";
      readonly intent: {
        readonly callRef: string;
        readonly toolName: string;
        readonly argumentsJson: string;
      };
    }
  | {
      readonly _tag: "Communicate";
      readonly message: { readonly text: string };
    }
  | { readonly _tag: "DeclareDependency"; readonly spec: unknown }
  | { readonly _tag: "RequestGovernance"; readonly request: unknown }
  | { readonly _tag: "SpawnSpecialist"; readonly spec: unknown }
  | { readonly _tag: "ProposeChildWorkspace"; readonly spec: unknown }
  | {
      readonly _tag: "LoadSkill";
      readonly skillId: string;
      readonly tier: "Summary" | "Body";
    }
  | { readonly _tag: "ChangeMode"; readonly mode: string }
  | {
      readonly _tag: "CompletionClaim";
      readonly claim: {
        readonly claimRef: string;
        readonly workRevision: number;
      };
    }
  | {
      readonly _tag: "Yield";
      readonly reason: string;
      readonly waitSpec: WaitSpec;
    };

export type DirectiveKind = AgentDirective["_tag"];
export const AGENT_DIRECTIVE_CONTRACT = "agent-directive-v1";
export const COMPLETION_CLAIM_CONTRACT = "completion-claim-v1";
export const TOOL_INVOCATION_CONTRACT = "tool-invocation-v1";

/** Frozen output-contract JSON Schemas (P3 `01` §4). A known contract ref
 * resolves to its schema; unknown refs resolve to null (the caller decides
 * whether that is admissible — never a silent fallback). */
const OUTPUT_CONTRACT_SCHEMAS: Readonly<Record<string, string>> = {
  [AGENT_DIRECTIVE_CONTRACT]: JSON.stringify({
    oneOf: [
      { properties: { _tag: { const: "Communicate" } }, required: ["_tag"] },
      {
        properties: { _tag: { const: "RequestGovernance" } },
        required: ["_tag"],
      },
      {
        properties: { _tag: { const: "ProposeChildWorkspace" } },
        required: ["_tag"],
      },
      {
        properties: { _tag: { const: "SpawnSpecialist" } },
        required: ["_tag"],
      },
      {
        properties: { _tag: { const: "CompletionClaim" } },
        required: ["_tag"],
      },
      { properties: { _tag: { const: "Yield" } }, required: ["_tag"] },
      { properties: { _tag: { const: "Wait" } }, required: ["_tag"] },
      { properties: { _tag: { const: "LoadSkill" } }, required: ["_tag"] },
      {
        properties: { _tag: { const: "DeclareDependency" } },
        required: ["_tag"],
      },
      { properties: { _tag: { const: "ToolInvocation" } }, required: ["_tag"] },
    ],
  }),
  [COMPLETION_CLAIM_CONTRACT]: JSON.stringify({
    type: "object",
    required: ["claim"],
    properties: {
      claim: {
        type: "object",
        required: ["claimRef", "workRevision"],
        properties: {
          claimRef: { type: "string" },
          workRevision: { type: "number" },
        },
      },
    },
  }),
  [TOOL_INVOCATION_CONTRACT]: JSON.stringify({
    type: "object",
    required: ["invocations"],
    properties: {
      invocations: { type: "array", items: { type: "object" } },
    },
  }),
};

export const outputContractSchemaJson = (contractRef: string): string | null =>
  Object.hasOwn(OUTPUT_CONTRACT_SCHEMAS, contractRef)
    ? (OUTPUT_CONTRACT_SCHEMAS[contractRef] as string)
    : null;

/** Provider-neutral tool-call proposal. It carries transport identity and
 * model-authored arguments only; it has no Arbor action or authority meaning. */
export interface ToolInvocation {
  readonly providerTurnId: ProviderTurnId;
  /** Stable order within one provider turn for idempotency correlation. */
  readonly outputPosition: number;
  readonly callRef: string;
  readonly toolName: string;
  readonly argumentsJson: string;
}

export interface ModelOutput {
  readonly text: string;
  readonly toolInvocations: ReadonlyArray<ToolInvocation>;
  readonly finishReason: ProviderFinishReason;
}

export type DecodeResult =
  | { readonly ok: true; readonly output: ModelOutput }
  | {
      readonly ok: false;
      readonly violation: "ProviderEventDecodeViolation";
      readonly reason: string;
    };

const violation = (reason: string): DecodeResult => ({
  ok: false,
  violation: "ProviderEventDecodeViolation",
  reason,
});

/**
 * Reconstructs generic model output from normalized provider events. Semantic
 * tool validation and executable/control classification belong to Agent Runtime
 * registries, not Model Context.
 */
export const decodeTurn = (
  events: ReadonlyArray<CanonicalProviderEvent>,
): DecodeResult => {
  let text = "";
  let finishReason: ProviderFinishReason = "Stop";
  const toolInvocations: ToolInvocation[] = [];
  const callRefs = new Set<string>();
  let providerTurnId: ProviderTurnId | undefined;

  for (const event of events) {
    switch (event._tag) {
      case "TextDelta":
        text += event.text;
        break;
      case "ToolCallProposed":
        if (
          event.callRef.length === 0 ||
          event.toolName.length === 0 ||
          event.argumentsJson.length === 0
        ) {
          return violation("tool call is missing identity, name, or arguments");
        }
        if (callRefs.has(event.callRef)) {
          return violation(`duplicate tool call identity ${event.callRef}`);
        }
        if (providerTurnId === undefined) {
          return violation(
            "tool call appeared before its ProviderTurn identity",
          );
        }
        callRefs.add(event.callRef);
        toolInvocations.push({
          providerTurnId,
          outputPosition: toolInvocations.length,
          callRef: event.callRef,
          toolName: event.toolName,
          argumentsJson: event.argumentsJson,
        });
        break;
      case "TurnCompleted":
        finishReason = event.finishReason;
        break;
      case "TurnStarted":
        if (
          providerTurnId !== undefined &&
          providerTurnId !== event.providerTurnId
        ) {
          return violation(
            "provider event stream contains multiple ProviderTurn identities",
          );
        }
        providerTurnId = event.providerTurnId;
        break;
      case "ReasoningDelta":
      case "UsageReported":
      case "ContinuationState":
      case "TurnFailed":
        break;
      default: {
        const exhaustive: never = event;
        return violation(`unsupported provider event ${String(exhaustive)}`);
      }
    }
  }

  if (text.length === 0 && toolInvocations.length === 0) {
    return violation("turn produced neither text nor a tool invocation");
  }

  return { ok: true, output: { text, toolInvocations, finishReason } };
};
