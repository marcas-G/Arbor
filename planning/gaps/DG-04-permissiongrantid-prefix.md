# DG-04 — `PermissionGrantId` missing from Appendix A prefix table

## Status

RESOLVED — DID v1.4.

## Resolution

Appendix A now includes `Permission Grant | pgr_`, placed between Decision
and Acceptance.

Authority:

- `docs/design/03-detailed-implementation-design.md` v1.4 Appendix A, §2.1

Resolved in: DID v1.4.

## Owning design document

`docs/design/03-detailed-implementation-design.md` (§2.1 vs Appendix A).

## Symptom

§2.1 lists `PermissionGrantId` as a required typed ID (DID:661), and §2.2
requires every independent durable identity to carry a prefix. Appendix A
lists 19 prefixes but omits `PermissionGrantId`.

## Evidence

```text
§2.1 (DID:661):  PermissionGrantId
Appendix A (DID:3836-3856): prj_ ws_ wrk_ exe_ ses_ ver_ dep_ del_ msg_
  art_ dec_ acc_ evd_ mem_ cmd_ evt_ ptn_ tin_ wkr_
```

No prefix is defined for `PermissionGrantId`.

## Why planning cannot decide this

The prefix convention is frozen in Appendix A. Inventing a prefix in
planning would create an unreviewed identifier convention.

## Required resolution

Manual governance must add the `PermissionGrantId` prefix to Appendix A
(or remove `PermissionGrantId` from §2.1, which would be a larger change).

## Affected planning tasks

- `P0-002` (typed ID kernel)
