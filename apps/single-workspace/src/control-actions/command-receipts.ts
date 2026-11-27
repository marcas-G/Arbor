import type { AgentActionError } from "@arbor/agent-runtime";
import {
  type CommandHandlerError,
  type CommandHandlerRegistryService,
  decodeRegisteredCommandReceipt,
  FINGERPRINT_ALGORITHM_VERSION,
  type GatewayEnvelope,
  newUuid7,
  type RegisteredCommandType,
  semanticRequestFingerprint,
} from "@arbor/application";
import {
  CommandId,
  type CommandId as CommandIdType,
  type CommandReceipt,
  type CommandSubmissionContext,
  type LeaseGeneration,
  type ProjectId,
  parse,
} from "@arbor/domain";
import type {
  CommandStoreError,
  CommandStoreService,
  TransactionOperationalFailure,
  TransactionPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";

export const actionError = (
  safeMessage: string,
  code: Extract<
    AgentActionError,
    { readonly _tag: "AgentActionRejected" }
  >["code"] = "action/precondition",
  correction: Extract<
    AgentActionError,
    { readonly _tag: "AgentActionRejected" }
  >["correction"] = "ChooseAlternative",
): AgentActionError => ({
  _tag: "AgentActionRejected",
  code,
  safeMessage,
  correction,
});

export const actionOperationalFailure =
  (operation: string) =>
  (cause: unknown): AgentActionError =>
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    (cause._tag === "AgentActionRejected" ||
      cause._tag === "AgentActionOperationalFailure" ||
      cause._tag === "AgentActionRecoveryBlocked")
      ? (cause as AgentActionError)
      : {
          _tag: "AgentActionOperationalFailure",
          operation,
          cause,
        };

export const generationScopedCommandId = (
  namespace: string,
  occurrence: string,
  context: CommandSubmissionContext,
): CommandIdType => {
  const seed =
    context._tag === "ExecutionOrigin" && context.fencingGeneration !== 0
      ? `${occurrence}:generation:${context.fencingGeneration}`
      : occurrence;
  return parse(CommandId)(`cmd_${newUuid7(namespace, seed)}`);
};

export const legacySelectCurrentWorkCommandId = (
  decisionId: string,
): CommandIdType => parse(CommandId)(`cmd_${decisionId.slice("dec_".length)}`);

export const selectCurrentWorkCommandId = (
  decisionId: string,
  occurrence: string,
  context: CommandSubmissionContext,
): CommandIdType =>
  context._tag === "ExecutionOrigin" && context.fencingGeneration > 0
    ? generationScopedCommandId(
        "select-current-work-command",
        occurrence,
        context,
      )
    : legacySelectCurrentWorkCommandId(decisionId);

export const isFencingRejectedReceipt = (resolution: unknown): boolean =>
  typeof resolution === "object" &&
  resolution !== null &&
  "_tag" in resolution &&
  resolution._tag === "TerminalRejected" &&
  "error" in resolution &&
  typeof resolution.error === "object" &&
  resolution.error !== null &&
  "_tag" in resolution.error &&
  resolution.error._tag === "FencingRejected";

export type PriorCommittedCommandReceipt = Omit<
  CommandReceipt<unknown, unknown>,
  "resolution"
> & {
  readonly resolution: Extract<
    CommandReceipt<unknown, unknown>["resolution"],
    { readonly _tag: "Committed" }
  >;
};

type PriorRejectedCommandReceipt = Omit<
  CommandReceipt<unknown, unknown>,
  "resolution"
> & {
  readonly resolution: Extract<
    CommandReceipt<unknown, unknown>["resolution"],
    { readonly _tag: "TerminalRejected" }
  >;
};

type PriorCommandReceipt =
  | { readonly _tag: "None" }
  | {
      readonly _tag: "Committed";
      readonly receipt: PriorCommittedCommandReceipt;
    }
  | {
      readonly _tag: "TerminalRejected";
      readonly receipt: PriorRejectedCommandReceipt;
    };

/** E09: the shared receipt-first helpers keep their narrow typed failures
 * (ports store/transaction failures plus the application command-handler
 * channel) while composing inside the capability handlers. Each handler folds
 * exactly once at the AgentActionHandler boundary it owns; every caller passes
 * the same operation string the helper-level fold used to carry, so the folded
 * AgentActionError values are unchanged on every path. */
export type PriorCommandReceiptError =
  | CommandStoreError
  | TransactionOperationalFailure;

export type PriorCommittedReplayError =
  | CommandHandlerError
  | TransactionOperationalFailure;

/** Shared receipt-first boundary. The caller retains command identity and all
 * canonical-result/error-algebra decisions; this function only reads older
 * generation receipts, validates their envelope identity, and skips fences.
 * `DecodeFailure` is the caller's committed-decode recovery channel; its
 * members join the composed union instead of being pre-folded. */
export const findPriorCommandReceipt = <DecodeFailure>(input: {
  readonly context: Extract<
    CommandSubmissionContext,
    { readonly _tag: "ExecutionOrigin" }
  >;
  readonly namespace: string;
  readonly occurrence: string;
  readonly includeCurrent?: boolean;
  readonly legacyCommandId?: CommandIdType;
  readonly commandReceipts:
    | Pick<CommandStoreService, "findResolution">
    | undefined;
  readonly tx: TransactionPortService;
  readonly projectId: ProjectId;
  readonly commandType: RegisteredCommandType;
  readonly commandHandlerRegistry: CommandHandlerRegistryService | undefined;
  readonly onCommittedDecodeFailure?: (
    commandId: CommandIdType,
  ) => Effect.Effect<never, DecodeFailure>;
  readonly operation: string;
  readonly lookupOperation?: string;
  readonly identityErrorMessage?: string;
}): Effect.Effect<
  PriorCommandReceipt,
  AgentActionError | PriorCommandReceiptError | DecodeFailure
> =>
  Effect.gen(function* () {
    if (input.commandReceipts === undefined) {
      return yield* Effect.fail(
        actionOperationalFailure(input.lookupOperation ?? input.operation)(
          "receipt lookup is required for generation takeover",
        ),
      );
    }
    for (
      let priorGeneration = 0;
      priorGeneration <
      input.context.fencingGeneration + (input.includeCurrent ? 1 : 0);
      priorGeneration += 1
    ) {
      const priorCommandId =
        priorGeneration === 0 && input.legacyCommandId !== undefined
          ? input.legacyCommandId
          : generationScopedCommandId(input.namespace, input.occurrence, {
              ...input.context,
              fencingGeneration: priorGeneration as LeaseGeneration,
            });
      const prior = yield* input.tx.transact(
        input.commandReceipts.findResolution(priorCommandId),
      );
      if (Option.isNone(prior)) continue;
      if (
        prior.value.commandId !== priorCommandId ||
        prior.value.projectId !== input.projectId
      ) {
        return yield* Effect.fail(
          actionOperationalFailure(input.operation)(
            input.identityErrorMessage ??
              "prior Command receipt has a mismatched identity",
          ),
        );
      }
      if (input.commandHandlerRegistry === undefined) {
        return yield* Effect.fail(
          actionOperationalFailure(input.operation)(
            "trusted command handler registry is required to decode a prior receipt",
          ),
        );
      }
      const handler = input.commandHandlerRegistry.lookup(input.commandType);
      if (
        Option.isNone(handler) ||
        handler.value.commandType !== input.commandType
      ) {
        return yield* Effect.fail(
          actionOperationalFailure(input.operation)(
            "trusted prior receipt command handler is not registered",
          ),
        );
      }
      const storedSchemaVersion = prior.value.schemaVersion;
      if (
        storedSchemaVersion !== handler.value.schemaVersion &&
        !(handler.value.priorReceiptSchemaVersions ?? []).includes(
          storedSchemaVersion,
        )
      ) {
        if (
          prior.value.resolution === "Committed" &&
          input.onCommittedDecodeFailure !== undefined
        ) {
          return yield* input.onCommittedDecodeFailure(priorCommandId);
        }
        return yield* Effect.fail(
          actionOperationalFailure(input.operation)(
            "prior Command receipt schema is not registered for strict replay",
          ),
        );
      }
      const decodedPrior = yield* decodeRegisteredCommandReceipt<unknown>(
        prior.value,
        input.commandType,
        storedSchemaVersion,
      ).pipe(
        Effect.catch(
          (
            failure: CommandStoreError,
          ): Effect.Effect<never, CommandStoreError | DecodeFailure> =>
            failure._tag === "PersistenceCorruption" &&
            prior.value.resolution === "Committed" &&
            input.onCommittedDecodeFailure !== undefined
              ? input.onCommittedDecodeFailure(priorCommandId)
              : Effect.fail(failure),
        ),
      );
      if (decodedPrior.resolution._tag === "Committed") {
        return {
          _tag: "Committed" as const,
          receipt: decodedPrior as PriorCommittedCommandReceipt,
        };
      }
      if (isFencingRejectedReceipt(decodedPrior.resolution)) continue;
      return {
        _tag: "TerminalRejected" as const,
        receipt: decodedPrior as PriorRejectedCommandReceipt,
      };
    }
    return { _tag: "None" as const };
  });

export const validatePriorCommittedReplay = <Payload>(input: {
  readonly receipt: PriorCommittedCommandReceipt;
  readonly commandType: RegisteredCommandType;
  readonly payload: Payload;
  readonly context: Extract<
    CommandSubmissionContext,
    { readonly _tag: "ExecutionOrigin" }
  >;
  readonly actor: import("@arbor/domain").Actor;
  readonly registry: CommandHandlerRegistryService | undefined;
  readonly tx: TransactionPortService;
}): Effect.Effect<void, AgentActionError | PriorCommittedReplayError> =>
  Effect.gen(function* () {
    if (input.registry === undefined) {
      return yield* Effect.fail(
        actionOperationalFailure(`${input.commandType}.priorReceipt`)(
          "trusted command handler registry is required to validate committed replay",
        ),
      );
    }
    const found = input.registry.lookup(input.commandType);
    if (Option.isNone(found) || found.value.commandType !== input.commandType) {
      return yield* Effect.fail(
        actionOperationalFailure(`${input.commandType}.priorReceipt`)(
          "trusted command handler is not registered for committed replay",
        ),
      );
    }
    const handler = found.value;
    if (
      input.receipt.schemaVersion !== handler.schemaVersion &&
      !(handler.priorReceiptSchemaVersions ?? []).includes(
        input.receipt.schemaVersion,
      )
    ) {
      return yield* Effect.fail(
        actionOperationalFailure(`${input.commandType}.priorReceipt`)(
          "committed receipt schema is not registered for replay",
        ),
      );
    }
    const expectedFingerprint = semanticRequestFingerprint({
      commandType: input.commandType,
      projectId: input.receipt.projectId,
      actor: input.actor,
      schemaVersion: input.receipt.schemaVersion,
      payload: input.payload,
    });
    if (
      input.receipt.fingerprintAlgorithmVersion !==
        FINGERPRINT_ALGORITHM_VERSION ||
      input.receipt.semanticRequestFingerprint !== expectedFingerprint
    ) {
      return yield* Effect.fail(
        actionOperationalFailure(`${input.commandType}.priorReceipt`)(
          "committed receipt does not bind the exact replay payload and actor",
        ),
      );
    }
    if (handler.validateReceiptReplay === undefined) {
      return yield* Effect.fail(
        actionOperationalFailure(`${input.commandType}.priorReceipt`)(
          "committed receipt has no canonical replay validator",
        ),
      );
    }
    const envelope: GatewayEnvelope<Payload> = {
      commandType: input.commandType,
      commandId: input.receipt.commandId,
      projectId: input.receipt.projectId,
      actor: input.actor,
      issuedAt: input.receipt.createdAt,
      payload: input.payload,
    };
    yield* input.tx.transact(
      handler.validateReceiptReplay(
        input.receipt as never,
        input.payload,
        envelope,
        input.context,
      ),
    );
  });
