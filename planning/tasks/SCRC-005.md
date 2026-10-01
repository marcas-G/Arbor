# SCRC-005 — AgentStepContext, ContextProjector, Manifest

## Source

- SD v1.4 §5.5; DID v1.22 §3.7, §8.2, §8.19, §10; T16–T18

## Depends On

- SCRC-003
- SCRC-004

## Objective

Capture one consistent per-sampling AgentStepContext and project canonical
control plus the active typed Session frontier into deterministic
PortableInputItems/Manifest. Move work/instruction/message assembly behind the
projector without treating the snapshot as authority.

## Outputs

- AgentStepContext capture service/module;
- ContextProjector and deterministic ordering/fingerprint;
- expanded ModelContextManifest + provider intent persistence;
- compatibility removal for direct assembler concatenation;
- `scrc-context-projector` suite.

## Must Hold

- same snapshot/frontier → same request/manifest hash;
- canonical control refs/revisions are fresh at capture and reinjected after compact;
- effect admission re-reads ControlBasis/authority;
- DataOnly content cannot become instruction/permission by text.

## Must Not Decide

- No canonical mutation, Inbox consumption, Tool execution or Provider call in projector.

## Acceptance

- T16–T18 pass; package DAG unchanged; all Manifest refs trace to durable sources.

## Verification

```bash
pnpm test scrc-context-projector
pnpm test p3-prepare-turn
pnpm architecture
```
