# Real-Provider Test Policy

**Audit date:** 2026-09-27

## Qualification requirements

Every black-box case that requires a real model must run against a declared
provider configuration, not a server that happens to be available on the
developer's machine. The evidence record must include:

- provider and model identifiers;
- endpoint and server/build identifier;
- temperature, reasoning settings, output/token limits, and relevant tool
  protocol settings;
- `provider_mode=REAL`;
- actual serialized provider request and actual response/events, associated by
  `providerTurnId` where available;
- case input, observable result, and negative-oracle results;
- test source revision and pinned toolchain.

Redact credentials and never persist secret material. Request/response evidence
must remain sufficient to replay or review the behavior without exposing
authentication data.

## Behavior stability

Use one unambiguous task, minimal fixtures, and a deterministic oracle.
Behavior-dependent sentinels should run three times under the same declared
configuration. All three outcomes are retained. Do not select the best run.
Mixed outcomes are `BEHAVIORALLY_UNSTABLE` evidence and do not pass the card.

Set temperature as low as the provider supports for the test purpose and
record the actual setting. Fixed generation parameters reduce variation but
do not turn a semantic capability into a deterministic contract.

## Test doubles

| Provider mode | Permitted proof |
|---|---|
| `REAL` | Model behavior, tool choice, memory use, steer cognition, semantic verification judgment |
| `RECORDING` | Request composition, routing, persistence, retry, deterministic state transitions |
| `FAKE` | Adapter-free deterministic driver/error paths |
| `NONE` | Pure functions, repositories, commands, projections, static contracts |

A test that replaces `fetch`, returns fixed SSE, or injects `ModelOutput` is
not `REAL`, even if it uses the production provider adapter.

## Current qualification availability

On 2026-09-27 the host had no configured live-provider variables. The default
Vitest run therefore made no live-provider request. The existing dated live
Human Input artifact remains historical, narrow evidence; it is not reused as
a current run or a full B01/B04 result.

S01/model-selected executable tool qualification and ControlToolRegistry
qualification remain outside the authorization in DID v1.18 Appendix C.
