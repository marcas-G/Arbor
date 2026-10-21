import {
  ExecutionId,
  parse,
  providerTurnInferenceId,
  providerTurnSummaryCompactionId,
} from "@arbor/domain";

const fixtureExecutionId = parse(ExecutionId)(
  "exe_00000000-0000-7000-8000-000000000001",
);

export const fixtureProviderTurnId = (stepNo = 0) =>
  providerTurnInferenceId(fixtureExecutionId, stepNo);

export const fixtureExecutionProviderTurnId = (
  executionId: string,
  stepNo = 0,
) => providerTurnInferenceId(parse(ExecutionId)(executionId), stepNo);

export const fixtureSummaryCompactionProviderTurnId = (
  executionId: string,
  stepNo: number,
  contextEpoch: number,
) =>
  providerTurnSummaryCompactionId(
    parse(ExecutionId)(executionId),
    stepNo,
    contextEpoch,
  );
