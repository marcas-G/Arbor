# SCRC-002 — Migration 0019, Session Store, Durable Input Promotion

## Source

- DID v1.22 §9.8; P2 `02` §10, `04` §3.8; P3 `04` §3.6; T04–T09

## Depends On

- SCRC-001

## Objective

Implement forward-only migration 0019, versioned SessionItem storage,
idempotent append/frontier/checkpoint APIs and transactional
`InputPromotionService` (Session append + Inbox consumed).

## Outputs

- migration 0019 and migration/re-entry fixtures from v18;
- Session repository methods and SQLite implementation;
- Application InputPromotionService;
- `scrc-session-migration` / `scrc-input-promotion` suites.

## Must Hold

- 0001–0018 unchanged; legacy rows retained and explicitly legacy;
- no callRef inference from text;
- same source/hash returns existing sequence; different hash conflicts;
- checkpoint + epoch CAS and Inbox append + consumed each converge atomically;
- fenced worker writes use full holder triple.

## Must Not Decide

- No Steer/Queue scheduling policy beyond the promotion input; no tool repair or compaction orchestration.

## Acceptance

- T04–T09 pass at both sides of transaction fault boundaries.

## Verification

```bash
pnpm test scrc-session-migration
pnpm test scrc-input-promotion
pnpm test p2-session-append
```
