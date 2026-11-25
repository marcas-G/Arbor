# Workspace authorization to exact Linux execution policy

Date: 2026-11-16  
Status: engineering application of accepted Workspace authority; integration in progress

## Source decisions

The owner accepted persistent Workspace authority, explicit bounded direct-Parent
allocation, and user-only reversal of human revocation. Their governing decision
is `docs/decisions/2026-11-16-workspace-scoped-sandbox-authority.md`. This package
specifies the execution binding needed to apply them. It introduces no additional
human role, fabricated grant, implicit resource share or new permission choice.

## Durable representation

Extend the unreleased staged schema57 descriptor to contain the Workspace ledger
and the execution-policy provenance transition as one atomic migration. Existing
sandbox decisions and their receipt bytes remain unchanged. Their provenance is
explicitly LegacyHumanGrant. New WorkspaceAuthorization decisions use a real
same-Project/Workspace authorization revision foreign key and null legacy grant
columns. Closed constraints prohibit mixed or missing authority sources and
FullAccess for WorkspaceAuthorization. Existing execution/episode/revision keys,
retention triggers and provider-unavailable inbound foreign keys remain valid.
Migration performs an in-transaction foreign-key check before commit.

The additive-only staging description of the previous ledger package is
superseded for this unreleased descriptor. Runtime promotion still waits for
upgrader/signature/manifest/maintenance, composition and complete execution
consumers. No preserved user database is upgraded.

An internal `BindWorkspaceSandboxPolicy` command creates a policy from the
current effective Workspace authorization. Its exact receipt version1 contains
a version3 policy result: all exact execution/snapshot fields plus the originating
Workspace authorization revision. The effective Linux summary itself stays
version2; this does not change network controls or re-encode historical V1/V2
results. Version3 never passes a frozen V1/V2 decoder. Readers check exact
receipt/project/command/episode/policy digest and the Workspace authorization
revision against the row. Unknown/corrupt current facts cannot fall back.

## Application and runtime contract

Workspace authorization is standing authority; each execution policy is a fresh,
finite snapshot of current Execution/Episode, Workspace/resource policy, current
host/provider qualification, admitted mounts and limits. The existing preparation
and resource/current-source checks are reused with a host-only authority view;
they receive no invented human grants. A finite execution binding cannot outlive
the standing authorization if it has an explicit expiry.

The binder is an internal deterministic System operation, never an externally
submitted human decision or model-authored grant. It must prove current effective
Workspace authority and the exact active execution, and re-read the complete
authority/source chain in the Gateway transaction after preparation. Selection
must equal the current Workspace choice and the exact source revision. Existing
host, resource, episode and policy CAS checks stay enforced. It emits the existing
SandboxPolicyDecisionRecorded event with an explicitly versioned Workspace
provenance payload; historical event bytes remain readable.

Runtime binding must run before policy-dependent recovery gates and P4 execution
admission. Reuse is allowed only for an exact current binding whose Workspace
authorization and every current source still hold. Revocation, Parent source
change, invalidated scope or changed host/provider cannot be repaired by silently
granting authority. Missing/invalid authorization remains user-visible and does
not invoke a shell. Renewal rebinds policy from already accepted standing
authority; it cannot enlarge capability or resources. An authorization does not
constitute exact sensitive-action approval.

## Qualification and staging

First qualify the representation, migration and Gateway binder together with
historical receipt/FK compatibility and transaction rollback. Then compose the
ordinary resolver/transport/UI, automatic execution binding and revocation gates
as one production slice before schema promotion. Layer checks remain distinct
from source-free real-model/browser Linux shell/build/test, two-Workspace
isolation, stop/restart, verification and human acceptance. The delivery goal
remains active until that installed behavior is proved.
