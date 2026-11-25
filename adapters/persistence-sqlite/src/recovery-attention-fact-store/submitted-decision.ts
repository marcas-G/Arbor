import type {
  RecoveryAttentionFactStoreError,
  SubmittedDecisionBindingAttentionFact,
} from "@arbor/ports";
import {
  TransactionScope,
} from "@arbor/ports";
import {
  Effect,
  Option,
} from "effect";
import {
  decodeSubmittedDecisionBindingAttentionFactRow,
  type SubmittedDecisionBindingAttentionDbRow,
} from "../submitted-decision-binding-attention-codec.js";
import type { RecoveryAttentionFactStoreService } from "@arbor/ports";
import {
  submittedDecisionBindingColumns,
  decodeSubmittedDecisionBindingFact,
  factsAreEqual,
} from "./row-codecs.js";
import type { FactContext } from "./context.js";

export const makeSubmittedDecisionFacts = (context: FactContext): Pick<RecoveryAttentionFactStoreService, "isSubmittedDecisionBindingAvailable" | "recordSubmittedDecisionBindingFailure" | "findSubmittedDecisionBindingFailure" | "listSubmittedDecisionBindingFailures"> => {
  const { sql, run, ensureSubmittedDecisionBindingAvailable, readSubmittedDecisionBindingByTuple } = context;
  return {
        isSubmittedDecisionBindingAvailable: () =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const tables = yield* run(
              sql.unsafe<{ readonly name: string }>(
                `SELECT name FROM sqlite_master
                  WHERE type = 'table'
                    AND name = 'submitted_decision_binding_attention_facts'`,
              ),
            );
            return tables.length > 0;
          }),
        recordSubmittedDecisionBindingFailure: (input) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* ensureSubmittedDecisionBindingAvailable();
            const validInput = decodeSubmittedDecisionBindingAttentionFactRow({
              attention_fact_id: input.attentionFactId,
              event_id: input.eventId,
              project_id: input.projectId,
              execution_id: input.executionId,
              workspace_id: input.workspaceId,
              logical_step_no: input.logicalStepNo,
              repair_attempt: input.repairAttempt,
              provider_turn_id: input.providerTurnId,
              logical_action_id: input.logicalActionId,
              failure_code: input.failureCode,
              first_detected_at: input.firstDetectedAt,
            });
            if (validInput === undefined) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason:
                  "submitted DecisionEpisode fact input violates its closed physical codec",
              });
            }
            const prior = yield* readSubmittedDecisionBindingByTuple(input);
            if (prior[0] !== undefined) {
              const fact = yield* decodeSubmittedDecisionBindingFact(prior[0]);
              if (!factsAreEqual(fact, validInput)) {
                return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                  _tag: "RecoveryAttentionFactInvariantConflict",
                  reason:
                    "existing Submitted DecisionEpisode binding fact conflicts with its immutable tuple",
                });
              }
              return fact;
            }
            yield* run(
              sql.unsafe(
                `INSERT INTO submitted_decision_binding_attention_facts (
                   attention_fact_id, event_id, project_id, execution_id,
                   workspace_id, logical_step_no, repair_attempt,
                   provider_turn_id, logical_action_id, failure_code,
                   first_detected_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  validInput.attentionFactId,
                  validInput.eventId,
                  validInput.projectId,
                  validInput.executionId,
                  validInput.workspaceId,
                  validInput.logicalStepNo,
                  validInput.repairAttempt,
                  validInput.providerTurnId,
                  validInput.logicalActionId,
                  validInput.failureCode,
                  validInput.firstDetectedAt,
                ],
              ),
            );
            return validInput;
          }),
        findSubmittedDecisionBindingFailure: (attentionFactId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* ensureSubmittedDecisionBindingAvailable();
            const rows = yield* run(
              sql.unsafe<SubmittedDecisionBindingAttentionDbRow>(
                `SELECT ${submittedDecisionBindingColumns}
                   FROM submitted_decision_binding_attention_facts
                  WHERE attention_fact_id = ?`,
                [attentionFactId],
              ),
            );
            return rows[0] === undefined
              ? Option.none()
              : Option.some(yield* decodeSubmittedDecisionBindingFact(rows[0]));
          }),
        listSubmittedDecisionBindingFailures: (projectId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* ensureSubmittedDecisionBindingAvailable();
            const rows = yield* run(
              sql.unsafe<SubmittedDecisionBindingAttentionDbRow>(
                `SELECT ${submittedDecisionBindingColumns}
                   FROM submitted_decision_binding_attention_facts
                  WHERE project_id = ?
                  ORDER BY first_detected_at, attention_fact_id`,
                [projectId],
              ),
            );
            const facts: SubmittedDecisionBindingAttentionFact[] = [];
            for (const row of rows) {
              facts.push(yield* decodeSubmittedDecisionBindingFact(row));
            }
            return facts;
          }),
  };
};
