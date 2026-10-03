# P17 — 04 Turn Profile Resolver

## 1. Purpose

Static catalog exposure and `includeTools/includeControlTools` cannot express
purpose, handler readiness or exact registration identity. P17 introduces one
resolver before Model Context compilation.

```ts
type ExecutionPurpose =
  | "RootConversation"
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
  /** Runtime / authorization / replay identity; never the provider function name. */
  readonly identity: { stableId: string; version: string; implementationHash: string };
  /** Function name exposed only in this turn's model tool surface. */
  readonly modelName: string;
  readonly actionKind: AgentAction["_tag"];
  readonly codec: ControlToolCodec;
  readonly applicability: (facts: TurnProfileFacts) => boolean;
  readonly requiredCapability: string;
  readonly handlerIdentity: string;
}
```

Executable registrations additionally bind the exact ToolRuntime definition,
executor and side-effect semantics. Registry materialization captures both the
stable identity and its model-name alias for the turn. A later registration
change makes an old call typed Stale, never silently routes by name. Historical
aliases are replay-only: a new turn never advertises them.

## 4. Visibility invariant

```text
MODEL_VISIBLE(tool, turn)
⇒ PURPOSE_APPLICABLE
∧ CODEC_REGISTERED
∧ HANDLER_OR_EXECUTOR_READY
∧ CAPABILITY_ELIGIBLE
∧ PROVIDER_COMPATIBLE
∧ MODEL_NAME_UNIQUE_IN_TURN
```

Visibility does not grant execution authority. ToolRuntime/control handlers
still recheck exact intent, resource, approval, freshness and fencing.
`modelName` is not an authority key; provider output first resolves through the
recorded turn profile to the stable identity.

## 5. Frozen v1 profiles

| Purpose | Executable | Control | Output |
|---|---|---|---|
| RootConversation | none | `propose_workspace` only | text or typed control invocation |
| WorkspaceWork | admitted read/list/patch/shell/project tools | applicable Work controls only | tool invocation/text |
| Verification | admitted read-only tools | verifier controls only | verification contract |
| ExecutionBoundSpecialist | parent-distributed subset | applicable communication/delegation subset | specialist contract |
| Formation | optional admitted read/list | formation controls only | formation contract |

The accepted DID v1.29 CRAC successor closes the first chat-driven
organizational action. `propose_workspace` is the sole v1 conversation-safe
control: it records a Pending FormationProposal and cannot create or approve a
Workspace. The proposal and its human Governance Inbox entry commit together;
Governance is never promoted into an Agent Session. All executable, Work,
communication, specialist and verifier tools remain excluded. Its
ControlResult may enter only the same exact
ConversationResponseEpisode's next turn.
RecordDecision consumes the exact `gov:<proposalId>:<revision>` entry so a
settled proposal cannot remain in the actionable Queue.

**DID v1.30 CAPA successor:** visible Control definitions still do not grant
authority. Before handler execution, Agent Runtime resolves subject-bound
PermissionGrant + structural facts + Workspace policy. `ApprovalRequired`
persists `cap:<approvalId>:<revision>`, pauses the same Execution and resumes
the same AgentLoopStep after `ResolveControlApproval`. `assign_work` is visible
to WorkspaceWork under this gate; RootConversation exposure remains blocked by
RGI-DG-01.

## 6. Removal gate

P17 is incomplete until all production calls consume ResolvedTurnProfile and
the following are deleted:

- `PrepareTurnInput.includeTools`;
- `PrepareTurnInput.includeControlTools`;
- compiler injection of legacy universal `arbor_directive`;
- registry visibility based only on handler presence.

Manifest records profile identity/fingerprint and exact tool identities.
For controls, it records `stableId + version + implementationHash + modelName`.
