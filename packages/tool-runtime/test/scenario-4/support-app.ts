import type { ToolInvocationId } from "@arbor/domain";
import {
  type ExecutableApprovalRecord,
  type InvocationApproval,
  type ToolInvocationRecord,
  type ToolRuntimeError,
  ToolRuntimePort,
  TransactionPort,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { ToolDefinitionStoreLive, type ToolExecutor } from "../../src/index.js";
import {
  authority,
  context,
  intent,
  invocationId,
  okExecutor,
} from "./support.js";
import {
  clockDeps,
  invocationStoreDeps,
  type MutableState,
  type PipelineFaults,
  type PipelineTrace,
  projectEnvironmentDeps,
  resourceAdmissionDeps,
  sandboxDeps,
  sandboxProcessDeps,
  trustedLocalDeps,
  workspaceRepositoryDeps,
} from "./support-harness.js";
import {
  artifactDepsBuilder,
  authorityResolverLayerBuilder,
  evidenceDepsBuilder,
  executableApprovalDepsBuilder,
  p39DepsBuilder,
  reconciliationDepsBuilder,
  toolRuntimeBuilder,
} from "./support-wiring.js";

export const app = (
  admissionDeny = false,
  executor: ToolExecutor = okExecutor,
  faults: PipelineFaults = {},
  trace?: PipelineTrace,
  initialApprovalOrExecutableApproval?:
    | InvocationApproval
    | ExecutableApprovalRecord,
  authorityDeniedOrDeniedReplay: boolean | ToolInvocationRecord = false,
  suppliedP39DeniedReplay?: ToolInvocationRecord,
  p39CurrentEnvironmentRevision?: string,
  reconciliationRetry?: NonNullable<PipelineTrace["reconciliationRetry"]>,
) => {
  const authorityDenied =
    typeof authorityDeniedOrDeniedReplay === "boolean"
      ? authorityDeniedOrDeniedReplay
      : false;
  const p39DeniedReplay =
    suppliedP39DeniedReplay ??
    (typeof authorityDeniedOrDeniedReplay === "object"
      ? authorityDeniedOrDeniedReplay
      : undefined);
  const p39BindingEnabled =
    p39DeniedReplay !== undefined ||
    reconciliationRetry !== undefined ||
    p39CurrentEnvironmentRevision !== undefined ||
    trace?.currentEnvironmentRevisionValues !== undefined;
  const approval =
    initialApprovalOrExecutableApproval !== undefined &&
    !("routeKind" in initialApprovalOrExecutableApproval)
      ? initialApprovalOrExecutableApproval
      : undefined;
  const executableApproval =
    initialApprovalOrExecutableApproval !== undefined &&
    "routeKind" in initialApprovalOrExecutableApproval
      ? initialApprovalOrExecutableApproval
      : undefined;
  const s: MutableState = {
    approval: { value: approval },
    executableApproval: { value: executableApproval },
    environmentResolutionIndex: { value: 0 },
    environmentRevisionReadIndex: { value: 0 },
    workspaceReadIndex: { value: 0 },
  };
  const tx = Layer.succeed(TransactionPort, {
    transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
      Effect.suspend(() => {
        if (trace !== undefined)
          trace.transactionDepth = (trace.transactionDepth ?? 0) + 1;
        return Effect.provideService(body, TransactionScope, {
          session: { id: "t" },
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (trace !== undefined)
                trace.transactionDepth = (trace.transactionDepth ?? 1) - 1;
            }),
          ),
        );
      }),
  });
  const baseDeps = Layer.mergeAll(
    tx,
    ToolDefinitionStoreLive,
    sandboxDeps(faults, trace),
    sandboxProcessDeps(trace),
    trustedLocalDeps(trace),
    resourceAdmissionDeps(admissionDeny, faults, trace, p39BindingEnabled),
    invocationStoreDeps(s, faults, trace, p39DeniedReplay, reconciliationRetry),
    projectEnvironmentDeps(
      s,
      faults,
      trace,
      p39BindingEnabled,
      trace?.resolvedEnvironmentRevisionSequence,
    ),
    workspaceRepositoryDeps(s, faults, trace),
    clockDeps(),
  );
  const evidenceDeps = evidenceDepsBuilder(baseDeps, trace);
  const authorityResolverLayer = authorityResolverLayerBuilder(
    reconciliationRetry,
    authorityDenied,
    trace,
  );
  const deps =
    authorityResolverLayer !== undefined
      ? Layer.mergeAll(evidenceDeps, authorityResolverLayer)
      : evidenceDeps;
  const executableApprovalDeps = executableApprovalDepsBuilder(deps, s, trace);
  const toolRuntime = toolRuntimeBuilder(executor, trace);
  const p39Deps = p39DepsBuilder(
    executableApprovalDeps,
    p39BindingEnabled,
    s,
    trace,
    reconciliationRetry,
    p39CurrentEnvironmentRevision,
    p39DeniedReplay,
  );
  const reconciliationDeps = reconciliationDepsBuilder(
    p39Deps,
    reconciliationRetry,
    trace,
  );
  const artifactDeps = artifactDepsBuilder(reconciliationRetry);
  const runtimeDeps =
    artifactDeps === undefined
      ? reconciliationDeps
      : Layer.mergeAll(reconciliationDeps, artifactDeps);
  return Layer.mergeAll(runtimeDeps, Layer.provide(toolRuntime, runtimeDeps));
};

export const run = (
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases the app layer type
  appLayer: Layer.Layer<any, any, any>,
  argumentsJson: string,
  approvalId: string | null = null,
  invocationOrContext:
    | ToolInvocationId
    | import("@arbor/ports").ToolExecutionContext = intent(
    argumentsJson,
  ).invocationId,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* ToolRuntimePort;
        const invocationId =
          typeof invocationOrContext === "string"
            ? invocationOrContext
            : intent(argumentsJson).invocationId;
        const executionContext =
          typeof invocationOrContext === "string"
            ? context
            : invocationOrContext;
        return yield* runtime.invoke(
          { ...intent(argumentsJson), approvalId, invocationId } as never,
          executionContext,
        );
      }),
      appLayer,
    ) as Effect.Effect<{ _tag: string }, unknown, never>,
  );

export const shellAuthority = {
  ...authority,
  toolName: "shell",
  toolVersion: "2",
  allowedCapabilities: ["shell:exec"],
};
export const runShell = (
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases the app layer type
  appLayer: Layer.Layer<any, any, any>,
  command: string,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* ToolRuntimePort;
        return yield* runtime.invoke(
          {
            ...intent(
              JSON.stringify({
                command,
                cwd: { mount: "workspace", path: "." },
              }),
            ),
            toolName: "shell",
            toolVersion: "2",
          } as never,
          { ...context, authority: shellAuthority } as never,
        );
      }),
      appLayer,
    ) as Effect.Effect<{ _tag: string }, unknown, never>,
  );

export const runFailure = (
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases the app layer type
  appLayer: Layer.Layer<any, any, any>,
  argumentsJson: string,
): Promise<ToolRuntimeError> =>
  Effect.runPromise(
    Effect.flip(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(intent(argumentsJson) as never, context);
        }),
        appLayer,
      ),
    ) as Effect.Effect<ToolRuntimeError, never, never>,
  );

/** The P39 retry app wiring shared by the replay-gatekeeping,
 * terminal-receipts and reconciliation-recovery suites: fresh executor and
 * trace with the prior invocation replayed against revision "rev". */
export const retryApp = (
  executor: ToolExecutor,
  trace: PipelineTrace,
  prior: import("@arbor/ports").ToolInvocationRecord,
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases the app layer type
): Layer.Layer<any, any, never> =>
  app(
    false,
    executor,
    {},
    trace,
    undefined,
    false,
    prior,
    "rev",
    trace.reconciliationRetry,
  );

const shellRetryIntent = (argumentsJson: string, approvalId: string | null) =>
  ({
    ...intent(argumentsJson),
    toolName: "shell",
    toolVersion: "2",
    invocationId,
    approvalId,
  }) as never;

/** Invoke a shell retry through the given (retry-wired) app layer. */
export const runShellRetry = (
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases the app layer type
  appLayer: Layer.Layer<any, any, any>,
  executionContext: import("@arbor/ports").ToolExecutionContext,
  argumentsJson: string,
  approvalId: string | null = null,
): Promise<{ _tag: string }> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* ToolRuntimePort;
        return yield* runtime.invoke(
          shellRetryIntent(argumentsJson, approvalId),
          executionContext,
        );
      }),
      appLayer,
    ) as Effect.Effect<{ _tag: string }, unknown, never>,
  );

/** Same as runShellRetry, but folding the failure channel into the result so
 * a denial/failure assertion stays one expect on a tagged object. */
export const runShellRetryMatched = (
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases the app layer type
  appLayer: Layer.Layer<any, any, any>,
  executionContext: import("@arbor/ports").ToolExecutionContext,
  argumentsJson: string,
  approvalId: string | null = null,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.match(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(
            shellRetryIntent(argumentsJson, approvalId),
            executionContext,
          );
        }),
        {
          onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
          onSuccess: (value) => ({ _tag: "Success" as const, value }),
        },
      ),
      appLayer,
    ) as Effect.Effect<
      | { _tag: "Failure"; cause: ToolRuntimeError }
      | { _tag: "Success"; value: never },
      never,
      never
    >,
  );
