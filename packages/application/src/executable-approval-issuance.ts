import type {
  ExecutableApprovalBinding,
  ExecutableApprovalRecord,
  ExecutableApprovalStoreService,
  InvocationAuthority,
  ToolExecutionContext,
  TransactionPortService,
} from "@arbor/ports";
import {
  executableApprovalBindingMatches,
  executableApprovalKeyOf,
} from "@arbor/ports";
import { Effect, Option } from "effect";

export interface ExecutableApprovalCandidate {
  readonly approvalId: string;
  readonly expiresAt: string;
}

export interface ExecutableApprovalIssuerDependencies {
  readonly store: ExecutableApprovalStoreService;
  readonly transaction: TransactionPortService;
  /** Pure P12 fact production is lazy so a replay uses the first committed
   * ApprovalId and expiry without evaluating a fresh wall-clock TTL. */
  readonly resolveCandidate: (
    binding: ExecutableApprovalBinding,
    requestedAt: string,
  ) => Effect.Effect<ExecutableApprovalCandidate, unknown>;
}

export interface ExecutableApprovalBindingConflict {
  readonly _tag: "ExecutableApprovalBindingConflict";
  readonly key: ReturnType<typeof executableApprovalKeyOf>;
}

export interface ExecutableApprovalAuthorityMismatch {
  readonly _tag: "ExecutableApprovalAuthorityMismatch";
}

export type ExecutableApprovalIssuanceResult =
  | ExecutableApprovalRecord
  | "ExecutionStopping";

const sameStrings = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

/** Application-side issuance composition. Storage is required to linearize
 * Pending-row, Inbox admission, request event and P2 wake source in one
 * transaction. The P38 SQLite implementation supplies that port after 0038. */
export const issueExecutableApproval = (
  input: {
    readonly binding: ExecutableApprovalBinding;
    readonly authority: InvocationAuthority;
    readonly requestedAt: string;
    readonly executionFence: NonNullable<
      ToolExecutionContext["executionFence"]
    >;
  },
  dependencies: ExecutableApprovalIssuerDependencies,
): Effect.Effect<
  ExecutableApprovalIssuanceResult,
  | unknown
  | ExecutableApprovalBindingConflict
  | ExecutableApprovalAuthorityMismatch,
  never
> =>
  Effect.gen(function* () {
    if (
      input.authority.executionId !== input.binding.executionId ||
      input.authority.workspaceId !== input.binding.workspaceId ||
      input.authority.principal !== input.binding.subject ||
      input.authority.toolName !== input.binding.toolName ||
      input.authority.toolVersion !== input.binding.toolVersion ||
      input.authority.controlBasisDigest !== input.binding.controlBasisDigest ||
      input.authority.expiresAt <= input.requestedAt ||
      !sameStrings(
        input.authority.resourceSpaceIds,
        input.binding.targetResourceSpaceIds,
      )
    ) {
      return yield* Effect.fail({
        _tag: "ExecutableApprovalAuthorityMismatch" as const,
      });
    }
    const key = executableApprovalKeyOf(input.binding);
    const existing = yield* dependencies.transaction.transact(
      dependencies.store.findByActionKey(key),
    );
    if (Option.isSome(existing)) {
      if (!executableApprovalBindingMatches(existing.value, input.binding)) {
        return yield* Effect.fail({
          _tag: "ExecutableApprovalBindingConflict" as const,
          key,
        });
      }
      return existing.value;
    }

    const candidate = yield* dependencies.resolveCandidate(
      input.binding,
      input.requestedAt,
    );
    const winner = yield* dependencies.transaction.transact(
      dependencies.store.putPendingExact({
        ...input.binding,
        approvalId: candidate.approvalId,
        requestedAt: input.requestedAt,
        expiresAt: candidate.expiresAt,
        executionFence: input.executionFence,
      }),
    );
    if (winner === "ExecutionStopping") return winner;
    if (!executableApprovalBindingMatches(winner, input.binding)) {
      return yield* Effect.fail({
        _tag: "ExecutableApprovalBindingConflict" as const,
        key,
      });
    }
    return winner;
  });
