import type { WaitSpec } from "@arbor/domain";
import type {
  CanonicalProviderEvent,
  ProviderFinishReason,
} from "@arbor/ports";

/** DID v1.7 §8.15/§8.3; P3 `03` §3–§4. Provider events are normalized
 * transport vocabulary and never directly become a directive. */
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

export const OUTPUT_CONTRACTS: Readonly<
  Record<string, ReadonlyArray<DirectiveKind>>
> = {
  [AGENT_DIRECTIVE_CONTRACT]: [
    "InvokeTool",
    "Communicate",
    "DeclareDependency",
    "RequestGovernance",
    "SpawnSpecialist",
    "ProposeChildWorkspace",
    "LoadSkill",
    "ChangeMode",
    "CompletionClaim",
    "Yield",
  ],
  [COMPLETION_CLAIM_CONTRACT]: ["CompletionClaim"],
};

export interface DecodedDirective {
  readonly directive: AgentDirective;
  readonly decisionBasisManifestId: string;
}

export interface ModelOutput {
  readonly text: string;
  readonly directives: ReadonlyArray<DecodedDirective>;
  readonly finishReason: ProviderFinishReason;
}

export type DecodeResult =
  | { readonly ok: true; readonly output: ModelOutput }
  | {
      readonly ok: false;
      readonly violation: "ModelOutputContractViolation";
      readonly reason: string;
    };

const violation = (reason: string): DecodeResult => ({
  ok: false,
  violation: "ModelOutputContractViolation",
  reason,
});

/**
 * Decode a provider stream into a `ModelOutput` with validated directives.
 * A `ToolCallProposed` event is a raw proposal: it is only valid if the Output
 * Contract admits `InvokeTool`.
 */
export const decodeTurn = (
  events: ReadonlyArray<CanonicalProviderEvent>,
  outputContractRef: string,
  decisionBasisManifestId: string,
): DecodeResult => {
  const allowed = OUTPUT_CONTRACTS[outputContractRef];
  if (allowed === undefined) {
    return violation(`unknown output contract ${outputContractRef}`);
  }

  let text = "";
  let finishReason: ProviderFinishReason = "Stop";
  const directives: DecodedDirective[] = [];

  for (const event of events) {
    switch (event._tag) {
      case "TextDelta":
        text += event.text;
        break;
      case "ToolCallProposed": {
        if (!allowed.includes("InvokeTool")) {
          return violation(
            `output contract ${outputContractRef} does not admit InvokeTool`,
          );
        }
        directives.push({
          directive: {
            _tag: "InvokeTool",
            intent: {
              callRef: event.callRef,
              toolName: event.toolName,
              argumentsJson: event.argumentsJson,
            },
          },
          decisionBasisManifestId,
        });
        break;
      }
      case "TurnCompleted":
        finishReason = event.finishReason;
        break;
      default:
        break;
    }
  }

  if (text.length === 0 && directives.length === 0) {
    return violation("turn produced neither text nor a directive");
  }
  return { ok: true, output: { text, directives, finishReason } };
};
