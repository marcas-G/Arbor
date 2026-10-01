# P17 — 04 Turn Profile Resolver

## 1. Purpose

Static catalog exposure and `includeTools/includeControlTools` cannot express
purpose, handler readiness or exact registration identity. P17 introduces one
resolver before Model Context compilation.

```ts
type ExecutionPurpose =
  | "RootConversationRespond"
  | "WorkspaceWork"
  | "Verification"
  | "ExecutionBoundSpecialist"
  | "Formation";

interface ResolvedTurnProfile {
  readonly purpose: ExecutionPurpose;
  readonly profileVersion: string;
  readonly outputContractRef: string;
  readonly executableTools: ReadonlyArray<ResolvedToolIdentity>;
  readonly controlTools: ReadonlyArray<ResolvedControlToolIdentity>;
  readonly contextPolicyRef: string;
  readonly fingerprint: string;
}
```

## 2. Inputs

The resolver reads trusted facts only:

- Execution binding/focus and Agent mode;
- Workspace responsibility/resource boundary and current Work/Verification;
- exact registered definition/codec/handler/executor identities;
- effective capabilities and permission grants;
- project/workspace lifecycle and ControlBasis revisions;
- provider/model tool protocol compatibility.

It does not read prompt claims or Session text as authority.

## 3. Registration contract

Every model-facing control registration owns:

```ts
interface ControlToolRegistration {
  readonly identity: { name: string; version: string; hash: string };
  readonly actionKind: AgentAction["_tag"];
  readonly codec: ControlToolCodec;
  readonly applicability: (facts: TurnProfileFacts) => boolean;
  readonly requiredCapability: string;
  readonly handlerIdentity: string;
}
```

Executable registrations additionally bind the exact ToolRuntime definition,
executor and side-effect semantics. Registry materialization captures identity
for the turn; a later registration change makes an old call typed Stale, never
silently routes by name.

## 4. Visibility invariant

```text
MODEL_VISIBLE(tool, turn)
⇒ PURPOSE_APPLICABLE
∧ CODEC_REGISTERED
∧ HANDLER_OR_EXECUTOR_READY
∧ CAPABILITY_ELIGIBLE
∧ PROVIDER_COMPATIBLE
```

Visibility does not grant execution authority. ToolRuntime/control handlers
still recheck exact intent, resource, approval, freshness and fencing.

## 5. Frozen v1 profiles

| Purpose | Executable | Control | Output |
|---|---|---|---|
| RootConversationRespond | none | none | text final answer |
| WorkspaceWork | admitted read/list/patch/shell/project tools | applicable Work controls only | tool invocation/text |
| Verification | admitted read-only tools | verifier controls only | verification contract |
| ExecutionBoundSpecialist | parent-distributed subset | applicable communication/delegation subset | specialist contract |
| Formation | optional admitted read/list | formation controls only | formation contract |

Chat-driven organizational actions require a later explicit conversation
profile; they are not smuggled into RootConversationRespond.

## 6. Removal gate

P17 is incomplete until all production calls consume ResolvedTurnProfile and
the following are deleted:

- `PrepareTurnInput.includeTools`;
- `PrepareTurnInput.includeControlTools`;
- compiler injection of legacy universal `arbor_directive`;
- registry visibility based only on handler presence.

Manifest records profile identity/fingerprint and exact tool identities.
