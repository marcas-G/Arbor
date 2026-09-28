# Capability–Tool Map

## Capability map

| Tool/capability | Declared capability metadata | Side-effect semantics | Executor | Authority/admission | Approval | Current status |
|---|---|---|---|---|---|---|
| `read` | `fs:read` | ReadOnly | yes | yes | no | reachable |
| `list` | `fs:read` | ReadOnly | yes | yes | no | reachable |
| `patch` | `fs:write` | Idempotent | yes | yes | no | reachable |
| `shell` | `shell:exec` | Reconcilable | yes | yes | conditional by policy | reachable |
| committed project tool | registry-defined | registry-defined | no in current composition | catalog/runtime checks cannot reach executor | unknown | visible but denied |
| `arbor_directive` | not a ToolDefinition capability | n/a | no | driver/handlers/control-basis | branch-specific | directive representation |
| `LoadSkill` branch | n/a | n/a | SkillRegistry handler | registry availability | no | registry empty in composition |
| governance/child/specialist branches | n/a | n/a | gateway handlers | command/formation logic | branch-specific | partial |

## Tool justification

The current `ToolDefinition` carries capability metadata and side-effect semantics, but there is no per-turn “why this tool is exposed” field and no execution-purpose filter. The model sees descriptions and metadata; the runtime sees authority/admission. This is sufficient for catalog projection, but not enough to prove least-privilege exposure by purpose.

## Capability gaps

### G-01 — visible project definitions without executor binding

A project tool can be registered and projected into `PortableModelRequest.toolDefinitions`, yet current production execution only supplies builtin executors. This is a capability gap and an implementation-owner issue.

### G-02 — purpose-specific capability profiles are absent

The current `ModelCapabilityPort` resolves provider/model capability (`packages/model-context/src/model-catalog.ts`) but does not select a tool surface by execution purpose. A model/provider profile is therefore not the same as an exposure profile.

### G-03 — directive branches are broader than executable tool capability

`agent-directive-v1` admits organizational actions in every compiled turn unless the selected output contract differs. The absence of executable tools does not imply absence of organizational directives because `arbor_directive` remains visible.

## Ownership split

- **Implementation owner candidates:** project-tool executor registration, purpose-specific catalog filtering, representation compiler/decoder, richer observation transport.
- **Governance/Design owner candidates:** which branches are legal in Query/Verification/Conversation, which model-facing representations are canonical for each capability profile, and what semantic fields belong in currently empty payloads.

No changes are made in this audit.
