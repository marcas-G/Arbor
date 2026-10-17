import type { Execution } from "@arbor/domain";
import { executionEpisode } from "@arbor/domain";
import type {
  ConversationAttempt,
  ConversationCheckpointFrontier,
  ConversationCheckpointOwner,
  ConversationCheckpointSourceManifestV1,
  ConversationCheckpointSourceMessageV1,
  ConversationResponseJob,
  HumanMessageRecord,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";

type Message = Pick<
  HumanMessageRecord,
  "messageId" | "projectId" | "rootWorkspaceId" | "bodyRef" | "createdAt"
>;

type Job = Pick<
  ConversationResponseJob,
  | "messageId"
  | "projectId"
  | "rootWorkspaceId"
  | "state"
  | "revision"
  | "nextAttemptNo"
>;

type Attempt = Pick<
  ConversationAttempt,
  | "messageId"
  | "attemptNo"
  | "executionId"
  | "settledAt"
  | "settlementKind"
  | "retryDecision"
>;

type ExecutionEvidence = Pick<
  Execution,
  "executionId" | "projectId" | "workspaceId" | "binding" | "state"
>;

export interface ConversationAnsweredSource {
  readonly message: Message;
  readonly responseBody: string;
  readonly job: Job & {
    readonly state: Extract<
      ConversationResponseJob["state"],
      { _tag: "Answered" }
    >;
  };
  readonly attempt: Attempt;
  readonly execution: ExecutionEvidence;
  readonly manifestSource: ConversationCheckpointSourceMessageV1;
}

export interface ConversationCheckpointProjection {
  readonly checkpoint: Pick<
    ConversationCheckpointOwner,
    | "contextEpoch"
    | "coveredThrough"
    | "checkpointKind"
    | "checkpointRef"
    | "bindingFingerprint"
    | "sourceManifestJson"
  >;
  /** Authoritative source pairs represented by the current owner checkpoint. */
  readonly coveredAnswered: ReadonlyArray<ConversationAnsweredSource>;
  /** Authoritative Answered turns after the inclusive owner frontier and
   * before the first non-Answered/malformed gap or current response. */
  readonly uncoveredAnswered: ReadonlyArray<ConversationAnsweredSource>;
  /** The current immutable input, pinned exactly once from a matching Running
   * ResponseJob, active Attempt/Execution and admission revision. */
  readonly currentMessage: Message;
  readonly blockerMessageId: string | null;
}

export type ConversationCheckpointProjectionResult =
  | {
      readonly _tag: "Ready";
      readonly projection: ConversationCheckpointProjection;
    }
  | {
      readonly _tag: "Blocked";
      readonly reason:
        | "CurrentMessageMissing"
        | "CurrentJobNotRunning"
        | "CurrentAttemptOrExecutionMismatch"
        | "MalformedOwner"
        | "OwnerFrontierNotAuthoritative"
        | "CurrentMessageAlreadyCovered";
    };

const compare = (
  left: Pick<Message, "createdAt" | "messageId">,
  right: Pick<Message, "createdAt" | "messageId">,
): number =>
  left.createdAt === right.createdAt
    ? left.messageId < right.messageId
      ? -1
      : left.messageId > right.messageId
        ? 1
        : 0
    : left.createdAt < right.createdAt
      ? -1
      : 1;

const sameFrontier = (
  left: ConversationCheckpointFrontier | null,
  right: ConversationCheckpointFrontier | null,
): boolean =>
  left === null || right === null
    ? left === right
    : left.createdAt === right.createdAt && left.messageId === right.messageId;

const parseSourceManifest = (
  owner: ConversationCheckpointOwner,
): ConversationCheckpointSourceManifestV1 | null => {
  if (owner.checkpointKind === null) {
    return null;
  }
  if (
    owner.checkpointRef === null ||
    owner.sourceManifestJson === null ||
    owner.producerExecutionId === null ||
    owner.producerProviderTurnId === null ||
    (owner.checkpointKind === "Summary" && owner.bindingFingerprint !== null) ||
    (owner.checkpointKind === "ProviderNative" &&
      (owner.bindingFingerprint === null ||
        !/^p16fp_[0-9a-f]{64}$/u.test(owner.bindingFingerprint)))
  ) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(owner.sourceManifestJson);
    if (typeof value !== "object" || value === null) return null;
    const manifest = value as ConversationCheckpointSourceManifestV1;
    if (
      manifest.version !== 1 ||
      manifest.rootWorkspaceId !== owner.rootWorkspaceId ||
      Number(manifest.toEpoch) !== Number(owner.contextEpoch) ||
      Number(manifest.fromEpoch) + 1 !== Number(manifest.toEpoch) ||
      manifest.checkpointKind !== owner.checkpointKind ||
      manifest.producerExecutionId !== owner.producerExecutionId ||
      manifest.producerProviderTurnId !== owner.producerProviderTurnId ||
      !sameFrontier(manifest.coveredThrough, owner.coveredThrough) ||
      (manifest.coveredThrough === null) !==
        (manifest.coveredSources.length === 0)
    ) {
      return null;
    }
    const lastSource = manifest.coveredSources.at(-1);
    if (
      lastSource !== undefined &&
      !sameFrontier(
        { createdAt: lastSource.createdAt, messageId: lastSource.messageId },
        manifest.coveredThrough,
      )
    ) {
      return null;
    }
    for (let index = 0; index < manifest.coveredSources.length; index += 1) {
      const source = manifest.coveredSources[index];
      const previous = manifest.coveredSources[index - 1];
      if (
        source === undefined ||
        !/^[0-9a-f]{64}$/u.test(source.bodySha256) ||
        !/^[0-9a-f]{64}$/u.test(source.responseBodySha256) ||
        !Number.isSafeInteger(source.answeredJobRevision) ||
        !Number.isSafeInteger(source.admissionJobRevision) ||
        source.answeredJobRevision !== source.admissionJobRevision + 2 ||
        source.attemptNo < 0 ||
        source.bodyRef.length === 0 ||
        (previous !== undefined && compare(previous, source) >= 0)
      ) {
        return null as never;
      }
    }
    return manifest;
  } catch {
    return null;
  }
};

const isExactConversationEpisode = (
  execution: ExecutionEvidence,
  message: Message,
): boolean => {
  const episode = executionEpisode(execution as Execution);
  return (
    execution.projectId === message.projectId &&
    execution.workspaceId === message.rootWorkspaceId &&
    episode?._tag === "ConversationResponseEpisode" &&
    episode.messageId === message.messageId
  );
};

const answeredSource = (input: {
  readonly message: Message;
  readonly job: Job | undefined;
  readonly attempts: ReadonlyArray<Attempt>;
  readonly executions: ReadonlyArray<ExecutionEvidence>;
}): ConversationAnsweredSource | null => {
  const { message, job } = input;
  if (
    job === undefined ||
    job.messageId !== message.messageId ||
    job.projectId !== message.projectId ||
    job.rootWorkspaceId !== message.rootWorkspaceId ||
    job.state._tag !== "Answered"
  ) {
    return null;
  }
  const answeredJob = job as Job & {
    readonly state: Extract<
      ConversationResponseJob["state"],
      { _tag: "Answered" }
    >;
  };
  const attemptNo = answeredJob.nextAttemptNo - 1;
  const attempts = input.attempts.filter(
    (attempt) =>
      attempt.messageId === message.messageId &&
      attempt.attemptNo === attemptNo &&
      attempt.executionId === answeredJob.state.executionId,
  );
  const attempt = attempts[0];
  if (
    attempts.length !== 1 ||
    attempt === undefined ||
    attempt.settledAt === null ||
    attempt.settlementKind !== "Completed" ||
    attempt.retryDecision?._tag !== "Answer"
  ) {
    return null;
  }
  const executions = input.executions.filter(
    (execution) => execution.executionId === attempt.executionId,
  );
  const execution = executions[0];
  const episode =
    execution === undefined
      ? undefined
      : executionEpisode(execution as Execution);
  if (
    executions.length !== 1 ||
    execution === undefined ||
    !isExactConversationEpisode(execution, message) ||
    episode?._tag !== "ConversationResponseEpisode" ||
    answeredJob.revision !== episode.responseJobRevision + 2 ||
    execution.state.status !== "Settled" ||
    execution.state.settlement?._tag !== "Completed" ||
    execution.state.settlement.result._tag !== "ConversationResponseProduced" ||
    execution.state.settlement.result.messageId !== message.messageId
  ) {
    return null;
  }
  const source: ConversationCheckpointSourceMessageV1 = {
    createdAt: message.createdAt,
    messageId: message.messageId,
    bodyRef: message.bodyRef,
    bodySha256: sha256Hex(message.bodyRef),
    responseBodySha256: sha256Hex(answeredJob.state.responseBody),
    answeredJobRevision: answeredJob.revision,
    responseExecutionId: answeredJob.state.executionId,
    attemptNo,
    admissionJobRevision: episode.responseJobRevision,
  };
  return {
    message,
    responseBody: answeredJob.state.responseBody,
    job: answeredJob,
    attempt,
    execution,
    manifestSource: source,
  };
};

export const projectConversationCheckpointHistory = (input: {
  readonly owner: ConversationCheckpointOwner;
  readonly messages: ReadonlyArray<Message>;
  readonly responseJobs: ReadonlyArray<Job>;
  readonly attempts: ReadonlyArray<Attempt>;
  readonly executions: ReadonlyArray<ExecutionEvidence>;
  readonly currentMessageId: string;
  readonly currentExecution: ExecutionEvidence;
}): ConversationCheckpointProjectionResult => {
  const sorted = [...input.messages].sort(compare);
  const currentIndex = sorted.findIndex(
    (message) => message.messageId === input.currentMessageId,
  );
  const currentMessage = sorted[currentIndex];
  if (currentMessage === undefined) {
    return { _tag: "Blocked", reason: "CurrentMessageMissing" };
  }
  const jobs = new Map<string, Job>(
    input.responseJobs.map((job) => [String(job.messageId), job]),
  );
  const currentJob = jobs.get(String(input.currentMessageId));
  const currentAttemptNo =
    currentJob?.state._tag === "Running" ? currentJob.state.attemptNo : -1;
  const currentAttempts = input.attempts.filter(
    (attempt) =>
      attempt.messageId === input.currentMessageId &&
      attempt.attemptNo === currentAttemptNo &&
      attempt.executionId === input.currentExecution.executionId,
  );
  const currentEpisode = executionEpisode(input.currentExecution as Execution);
  if (
    currentJob === undefined ||
    currentJob.state._tag !== "Running" ||
    currentJob.state.executionId !== input.currentExecution.executionId
  ) {
    return { _tag: "Blocked", reason: "CurrentJobNotRunning" };
  }
  if (
    currentAttempts.length !== 1 ||
    currentAttempts[0]?.settledAt !== null ||
    currentAttempts[0]?.settlementKind !== null ||
    input.currentExecution.state.status !== "Active" ||
    !isExactConversationEpisode(input.currentExecution, currentMessage) ||
    currentEpisode?._tag !== "ConversationResponseEpisode" ||
    currentJob.revision !== currentEpisode.responseJobRevision + 1
  ) {
    return { _tag: "Blocked", reason: "CurrentAttemptOrExecutionMismatch" };
  }
  if (
    input.owner.checkpointKind === null &&
    (input.owner.checkpointRef !== null ||
      input.owner.coveredThrough !== null ||
      input.owner.bindingFingerprint !== null ||
      input.owner.sourceManifestJson !== null ||
      input.owner.producerExecutionId !== null ||
      input.owner.producerProviderTurnId !== null ||
      Number(input.owner.contextEpoch) !== 0)
  ) {
    return { _tag: "Blocked", reason: "MalformedOwner" };
  }
  const manifest = parseSourceManifest(input.owner);
  if (
    input.owner.checkpointKind !== null &&
    (manifest === null ||
      (input.owner.coveredThrough === null && input.owner.contextEpoch === 0))
  ) {
    return { _tag: "Blocked", reason: "MalformedOwner" };
  }
  if (
    input.owner.coveredThrough !== null &&
    compare(input.owner.coveredThrough, currentMessage) >= 0
  ) {
    return { _tag: "Blocked", reason: "CurrentMessageAlreadyCovered" };
  }

  const sourceFor = (message: Message) =>
    answeredSource({
      message,
      job: jobs.get(String(message.messageId)),
      attempts: input.attempts,
      executions: input.executions,
    });
  const coveredAnswered: ConversationAnsweredSource[] = [];
  if (manifest !== null) {
    const expectedCovered = sorted.filter((message) =>
      input.owner.coveredThrough === null
        ? false
        : compare(message, input.owner.coveredThrough) <= 0,
    );
    if (expectedCovered.length !== manifest.coveredSources.length) {
      return { _tag: "Blocked", reason: "OwnerFrontierNotAuthoritative" };
    }
    for (let index = 0; index < expectedCovered.length; index += 1) {
      const message = expectedCovered[index];
      const persisted = manifest.coveredSources[index];
      const source = message === undefined ? null : sourceFor(message);
      if (
        message === undefined ||
        persisted === undefined ||
        source === null ||
        persisted.createdAt !== message.createdAt ||
        persisted.messageId !== message.messageId ||
        persisted.bodyRef !== message.bodyRef ||
        persisted.responseExecutionId !==
          source.manifestSource.responseExecutionId ||
        persisted.attemptNo !== source.manifestSource.attemptNo ||
        persisted.admissionJobRevision !==
          source.manifestSource.admissionJobRevision ||
        persisted.answeredJobRevision !==
          source.manifestSource.answeredJobRevision ||
        persisted.bodySha256 !== source.manifestSource.bodySha256 ||
        persisted.responseBodySha256 !==
          source.manifestSource.responseBodySha256
      ) {
        return { _tag: "Blocked", reason: "OwnerFrontierNotAuthoritative" };
      }
      coveredAnswered.push(source);
    }
  }

  const afterFrontier = sorted.filter(
    (message) =>
      (input.owner.coveredThrough === null ||
        compare(message, input.owner.coveredThrough) > 0) &&
      compare(message, currentMessage) < 0,
  );
  const uncoveredAnswered: ConversationAnsweredSource[] = [];
  let blockerMessageId: string | null = null;
  for (const message of afterFrontier) {
    const source = sourceFor(message);
    if (source === null) {
      blockerMessageId = message.messageId;
      break;
    }
    uncoveredAnswered.push(source);
  }

  return {
    _tag: "Ready",
    projection: {
      checkpoint: {
        contextEpoch: input.owner.contextEpoch,
        coveredThrough: input.owner.coveredThrough,
        checkpointKind: input.owner.checkpointKind,
        checkpointRef: input.owner.checkpointRef,
        bindingFingerprint: input.owner.bindingFingerprint,
        sourceManifestJson: input.owner.sourceManifestJson,
      },
      coveredAnswered,
      uncoveredAnswered,
      currentMessage,
      blockerMessageId,
    },
  };
};
