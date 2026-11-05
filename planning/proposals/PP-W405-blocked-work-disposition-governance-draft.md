# PP-W405 — Blocked Work Public Disposition Governance Draft

Status: DRAFT — manual governance required.

## Failure evidence

A root WorkEpisode can consume terminal action rejections and settle on
`Completed(Yielded{waitFor: Manual})` while Work remains Open. Existing public
views show only a generic blocked/waiting state, with no typed reason or clear
recovery handle.

## Required decisions

- when terminal action rejection + Manual wait becomes public Attention;
- canonical record location: Work Detail, Attention, or both;
- exact typed reason and bounded evidence fields;
- legal resume action and clear condition;
- duplicate/replay behavior;
- prohibition on auto-retry, auto-complete, or fabricated Verification.

## Acceptance evidence

The accepted contract must prove public visibility, actionable resume, exact
clear behavior, Work remains Open, no Verification/Acceptance is fabricated,
and view reads cause no Provider/tool replay.

No implementation or status reinterpretation is authorized by this draft.
