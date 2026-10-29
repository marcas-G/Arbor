# SCRC-001 — Typed Session / Provider Item Protocol

## Source

- DID v1.22 §1.7, §7.5, §8.2, §8.19; P3 `01`/`02`; acceptance T01–T03

## Depends On

- —

## Objective

Define/export provider-neutral `SessionItem` and `PortableInputItem` ADTs,
operation kind, callRef-paired tool/control items, adapter capability metadata
and narrow incompatibility errors. Evolve request/manifest types without adding
a package edge or CanonicalProviderEvent variant.

## Outputs

- `packages/ports` item/request/capability contracts;
- `packages/model-context` compilation shapes;
- adapter compatibility shims required for existing providers/fakes;
- `scrc-item-protocol` tests.

## Must Hold

- `PortableMessage` is only the Message variant;
- ToolCall/ToolResult correlation survives round-trip and parallel ordering;
- unsupported item/operation fails typed, never textifies;
- secrets and authority claims are absent from items.

## Must Not Decide

- No DB/migration, promotion, compaction execution, provider family or new event.

## Acceptance

- T01–T03 and negative architecture assertions pass; exhaustive switches compile.

## Verification

```bash
pnpm test scrc-item-protocol
pnpm typecheck
pnpm architecture
```
