import type { CanonicalResourceRegion } from "@arbor/domain";
import {
  type ExecutableApprovalRecord,
  type ExecutableApprovalStoreService,
  executableApprovalBindingMatches,
  type ToolAuthorityResolverService,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolIntent,
  type ToolInvocationStoreService,
  type ToolRuntimeError,
  type TransactionPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { actionDigestOf, matchApproval } from "../approval.js";
import { checkInvocationAuthority } from "../authority.js";
import { recoveryBindingIdentityMatches } from "../recovery-binding.js";
import {
  approvalDenialCode,
  executableApprovalTerminalDenial,
  operationalFailure,
} from "./errors.js";
import type { makeNoEffectSettlement } from "./no-effect-settlement.js";
import type { ToolExecutor } from "./types.js";

/** Check existing invocation authority and approval, without consuming a new approval. */
export const resolveInvocationAuthority = (
  intent: ToolIntent,
  context: ToolExecutionContext,
  definition: ToolDefinition,
  executor: ToolExecutor,
  regions: ReadonlyArray<CanonicalResourceRegion>,
  now: string,
  options: { readonly maxDelegationDepth?: number },
  authorityResolver: Option.Option<ToolAuthorityResolverService>,
  executableApprovals: Option.Option<ExecutableApprovalStoreService>,
  tx: TransactionPortService,
  store: ToolInvocationStoreService,
  p39BindingEnabled: boolean,
  hasVerifiedReplayBinding: boolean,
  recordNoEffectDenial: ReturnType<
    typeof makeNoEffectSettlement
  >["recordNoEffectDenial"],
) =>
  Effect.gen(function* () {
    const resolvedAuthorityFromCurrent = Option.isSome(authorityResolver)
      ? yield* authorityResolver.value
          .resolve({
            intent,
            definition,
            context,
            regions,
            now,
          })
          .pipe(
            Effect.catchTag("ToolAuthorityDenied", () =>
              Effect.succeed(undefined),
            ),
            Effect.mapError(
              operationalFailure(
                "AuthorityResolution",
                String(intent.invocationId),
              ),
            ),
          )
      : context.authority;
    if (
      resolvedAuthorityFromCurrent === undefined &&
      !hasVerifiedReplayBinding
    ) {
      return {
        _tag: "Terminal" as const,
        observation: yield* recordNoEffectDenial(
          definition.sideEffectSemantics,
          regions,
          "InvocationAuthorityDenied",
        ),
      };
    }
    const resolvedAuthority =
      resolvedAuthorityFromCurrent ??
      context.authority ??
      ({
        principal: context.authenticatedPrincipal,
        workspaceId: context.workspaceId,
        executionId: context.executionId,
        toolName: intent.toolName,
        toolVersion: intent.toolVersion,
        resourceSpaceIds: regions.map((item) => item.resourceSpaceId),
        allowedCapabilities: definition.capabilityMetadata,
        controlBasisDigest: context.controlBasisDigest,
        expiresAt: context.requestedAt,
        delegationDepth: context.delegationDepth ?? 0,
      } as NonNullable<ToolExecutionContext["authority"]>);
    const authority = checkInvocationAuthority({
      authority: resolvedAuthority,
      definition,
      intent,
      context,
      regions,
      now,
      maxDelegationDepth: options.maxDelegationDepth ?? 1,
    });
    if (authority._tag === "Denied" && !hasVerifiedReplayBinding) {
      return {
        _tag: "Terminal" as const,
        observation: yield* recordNoEffectDenial(
          definition.sideEffectSemantics,
          regions,
          "InvocationAuthorityDenied",
        ),
      };
    }

    const needsApproval = executor.requiresApproval(intent);
    let approvalAlreadyConsumedBySelf = false;
    let currentApprovalRecord: ExecutableApprovalRecord | undefined;
    if (hasVerifiedReplayBinding) {
      approvalAlreadyConsumedBySelf = needsApproval;
    }
    if (
      !hasVerifiedReplayBinding &&
      !needsApproval &&
      context.executableApproval !== undefined
    ) {
      return {
        _tag: "Terminal" as const,
        observation: yield* recordNoEffectDenial(
          definition.sideEffectSemantics,
          regions,
          "ApprovalMismatch",
        ),
      };
    }
    if (!hasVerifiedReplayBinding && needsApproval) {
      if (context.executableApproval === undefined) {
        const legacyApprovalId = intent.approvalId;
        if (p39BindingEnabled && legacyApprovalId !== null) {
          return {
            _tag: "Terminal" as const,
            observation: yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              "ApprovalMismatch",
            ),
          };
        }
        if (legacyApprovalId === null) {
          return {
            _tag: "Terminal" as const,
            observation: {
              _tag: "ApprovalRequired" as const,
              authority: resolvedAuthority,
              targetResourceSpaceIds: regions.map(
                (region) => region.resourceSpaceId,
              ),
              actionDigest: actionDigestOf(intent),
              requestedCapabilities: definition.capabilityMetadata,
              sideEffectSemantics: definition.sideEffectSemantics,
              controlBasisDigest: context.controlBasisDigest,
            },
          };
        }
        const legacyApproval = yield* tx
          .transact(store.findApproval(legacyApprovalId))
          .pipe(
            Effect.mapError(
              operationalFailure("ApprovalLookup", String(intent.invocationId)),
            ),
          );
        if (Option.isNone(legacyApproval)) {
          return {
            _tag: "Terminal" as const,
            observation: yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              "ApprovalNotFound",
            ),
          };
        }
        if (legacyApproval.value.consumedBy === intent.invocationId) {
          const priorInvocation = yield* tx
            .transact(store.findById(intent.invocationId))
            .pipe(
              Effect.mapError(
                operationalFailure(
                  "ApprovalLookup",
                  String(intent.invocationId),
                ),
              ),
            );
          if (Option.isNone(priorInvocation)) {
            return {
              _tag: "Terminal" as const,
              observation: yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                regions,
                "ApprovalConsumedByOtherInvocation",
              ),
            };
          }
          approvalAlreadyConsumedBySelf = true;
        }
        const matched = matchApproval({
          approval: legacyApproval.value,
          intent,
          definition,
          context,
          regions,
          now,
          replayOfRecordedInvocation: approvalAlreadyConsumedBySelf,
        });
        if (matched._tag === "Denied") {
          return {
            _tag: "Terminal" as const,
            observation: yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              approvalDenialCode(matched.reason),
            ),
          };
        }
      } else {
        if (intent.approvalId !== context.executableApproval.approvalId) {
          return {
            _tag: "Terminal" as const,
            observation: yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              "ApprovalMismatch",
            ),
          };
        }
        if (Option.isNone(executableApprovals)) {
          return yield* Effect.fail(
            operationalFailure(
              "ApprovalLookup",
              String(intent.invocationId),
            )({
              _tag: "ExecutableApprovalStoreUnavailable",
            }),
          );
        }
        const exactExecutableApproval = yield* tx
          .transact(
            executableApprovals.value.findById(
              context.executableApproval.approvalId,
            ),
          )
          .pipe(
            Effect.mapError(
              operationalFailure("ApprovalLookup", String(intent.invocationId)),
            ),
          );
        if (Option.isSome(exactExecutableApproval)) {
          const currentApproval = exactExecutableApproval.value;
          currentApprovalRecord = currentApproval;
          if (currentApproval.state === "Pending") {
            if (
              context.executableApproval.state !== "Pending" ||
              currentApproval.revision !==
                context.executableApproval.expectedRevision ||
              !executableApprovalBindingMatches(
                currentApproval,
                context.executableApproval.binding,
              )
            ) {
              return {
                _tag: "Terminal" as const,
                observation: yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalMismatch",
                ),
              };
            }
            return {
              _tag: "Terminal" as const,
              observation: {
                _tag: "ApprovalRequired" as const,
                authority: resolvedAuthority,
                targetResourceSpaceIds: regions.map(
                  (region) => region.resourceSpaceId,
                ),
                actionDigest: actionDigestOf(intent),
                requestedCapabilities: definition.capabilityMetadata,
                sideEffectSemantics: definition.sideEffectSemantics,
                controlBasisDigest: context.controlBasisDigest,
              },
            };
          }
          if (currentApproval.state === "Cancelled") {
            return {
              _tag: "Terminal" as const,
              observation: { _tag: "Interrupted" as const },
            };
          }
          const terminalDenial = executableApprovalTerminalDenial(
            currentApproval,
            now,
          );
          if (terminalDenial !== null) {
            return {
              _tag: "Terminal" as const,
              observation: yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                regions,
                terminalDenial,
              ),
            };
          }
          if (
            currentApproval.state === "Consumed" &&
            currentApproval.consumedBy === intent.invocationId
          ) {
            const priorInvocation = yield* tx
              .transact(store.findById(intent.invocationId))
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "ApprovalLookup",
                    String(intent.invocationId),
                  ),
                ),
              );
            if (Option.isSome(priorInvocation)) {
              approvalAlreadyConsumedBySelf = true;
            }
          }
        }
        if (
          Option.isNone(exactExecutableApproval) ||
          exactExecutableApproval.value.routeKind !== "Executable" ||
          (exactExecutableApproval.value.state !==
            context.executableApproval.state &&
            !approvalAlreadyConsumedBySelf) ||
          !(
            (exactExecutableApproval.value.state === "Approved" &&
              exactExecutableApproval.value.revision ===
                context.executableApproval.expectedRevision) ||
            (approvalAlreadyConsumedBySelf &&
              exactExecutableApproval.value.state === "Consumed" &&
              exactExecutableApproval.value.revision ===
                context.executableApproval.expectedRevision + 1)
          ) ||
          exactExecutableApproval.value.expiresAt <= now ||
          !executableApprovalBindingMatches(
            exactExecutableApproval.value,
            context.executableApproval.binding,
          )
        ) {
          return {
            _tag: "Terminal" as const,
            observation: yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              exactExecutableApproval._tag === "Some" &&
                exactExecutableApproval.value.expiresAt <= now
                ? "ApprovalExpired"
                : "ApprovalMismatch",
            ),
          };
        }
        if (intent.approvalId !== context.executableApproval.approvalId) {
          return {
            _tag: "Terminal" as const,
            observation: yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              "ApprovalMismatch",
            ),
          };
        }
      }
    }
    if (
      p39BindingEnabled &&
      context.executableApproval !== undefined &&
      !recoveryBindingIdentityMatches({
        identity: context.recoveryBindingIdentity,
        executionId: context.executionId,
        invocationId: intent.invocationId,
        callRef: intent.callRef,
        approvalBinding: context.executableApproval.binding,
      })
    ) {
      return yield* Effect.fail<ToolRuntimeError>(
        operationalFailure(
          "RecoveryBinding",
          String(intent.invocationId),
        )({ _tag: "RecoveryBindingApprovalSourceMismatch" }),
      );
    }

    return {
      _tag: "Ready" as const,
      resolvedAuthority,
      needsApproval,
      approvalAlreadyConsumedBySelf,
      currentApprovalRecord,
    };
  });
