import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findArborConfigFile } from "../../../apps/single-workspace/src/provider-config.js";
import { archiveProductionFixtureFailure } from "../../functional/support/fixture-failure-evidence.js";
import {
  type ProductionFixture,
  type ProductionFixtureSetupProbeEvent,
  startProductionFixture,
} from "../../functional/support/production-fixture.js";
import { makePublicClient } from "../../functional/support/public-client.js";
import { removeFunctionalFixtureDirectory } from "../../functional/support/schema44-bootstrap.js";
import {
  createP39PrivateTestFile,
  makeP39PrivateTestDirectory,
  removeP39PrivateTestDirectory,
} from "../../support/p39-windows-deployment-test.js";
import { readProviderCaptures } from "./provider-response-gate.js";

export {
  providerCaptureMatchesSelector,
  readProviderCaptures,
  waitForHeldProviderResponse,
} from "./provider-response-gate.js";

export interface RealProviderConfig {
  readonly path: string;
  readonly deploymentId: string;
  readonly modelRef: string;
  readonly endpoint: string;
  readonly wireModelName: string;
  readonly secretKind: "env" | "file" | "inline";
}

export type RealProviderReadiness =
  | { readonly ready: true; readonly config: RealProviderConfig }
  | { readonly ready: false; readonly reason: string };

export interface ProviderCapture {
  readonly event:
    | "request-start"
    | "response-complete"
    | "response-held"
    | "response-released"
    | "response-capture-failed"
    | "request-failed";
  readonly requestId: string;
  readonly processId: number;
  readonly sequence: number;
  readonly method: string;
  readonly path: string;
  readonly request?: Record<string, unknown>;
  readonly status?: number;
  readonly responseBodyBase64?: string;
  readonly captureError?: string;
  readonly error?: string;
}

/** A response-gated upstream reply, joined by exact request identity with its
 * `response-complete` capture. The event remains `response-held`; the complete
 * response fields are copied only after the pair has been consistency-checked. */
export interface CorrelatedHeldProviderResponseCapture extends ProviderCapture {
  readonly event: "response-held";
  readonly status: number;
  readonly responseBodyBase64: string;
}

export interface StartedRealProviderFixture {
  readonly fixture: ProductionFixture;
  readonly captureFile: string;
  readonly evidenceDirectory: string;
  readonly privateRunDirectory: string;
  readonly archiveResultDirectory: string;
  readonly ownsArchiveResultDirectory: boolean;
  readonly responseGateDirectory?: string;
  fixtureArchiveDirectory?: string;
}

export interface ProviderResponseGateSelector {
  readonly requiredAdvertisedToolName?: string;
  readonly requiredMessageText?: string;
}

export interface WorkspaceFileSnapshot {
  readonly entries: Readonly<
    Record<
      string,
      {
        readonly kind: "file" | "directory";
        readonly size?: number;
        readonly sha256?: string;
        readonly bytesBase64?: string;
      }
    >
  >;
}

export interface CapturedProviderToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export const createRealProviderFixtureDaemonSetup = (input: {
  readonly baseDaemonEnvironment: Readonly<Record<string, string>>;
  /** Mutable by design: setupProbe may add fixture-private paths after clone,
   * and startProductionFixture reuses this object for every daemon restart. */
  readonly requiredDaemonEnvironment?: Record<string, string>;
  readonly setupProbe?: (
    event: ProductionFixtureSetupProbeEvent,
  ) => void | Promise<void>;
}) => {
  const requiredDaemonEnvironment = input.requiredDaemonEnvironment ?? {};
  const allowedKeys = new Set([
    "ARBOR_AUTH_TOKENS",
    "ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE",
  ]);
  const assertRequiredEnvironmentSafe = (fixtureDirectory?: string) => {
    const unexpectedKey = Object.keys(requiredDaemonEnvironment).find(
      (key) => !allowedKeys.has(key),
    );
    if (unexpectedKey !== undefined) {
      throw new Error(
        `required test daemon environment is not allowlisted: ${unexpectedKey}`,
      );
    }
    const authTokens = requiredDaemonEnvironment.ARBOR_AUTH_TOKENS;
    if (
      authTokens !== undefined &&
      authTokens !== "local=user:local,operator=user:operator"
    ) {
      throw new Error(
        "P11 fixture auth tokens differ from the local test pair",
      );
    }
    const authoritySourceFile =
      requiredDaemonEnvironment.ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE;
    if (authoritySourceFile !== undefined) {
      if (fixtureDirectory === undefined || !isAbsolute(authoritySourceFile)) {
        throw new Error(
          "P11 authority source must be an absolute path inside the private fixture",
        );
      }
      const authorityRelativePath = relative(
        resolve(fixtureDirectory),
        resolve(authoritySourceFile),
      );
      if (
        authorityRelativePath.length === 0 ||
        authorityRelativePath === ".." ||
        authorityRelativePath.startsWith(`..${sep}`) ||
        isAbsolute(authorityRelativePath)
      ) {
        throw new Error(
          "P11 authority source must be an absolute path inside the private fixture",
        );
      }
    }
  };
  assertRequiredEnvironmentSafe();
  const daemonEnvironment: Record<string, string> = {
    ...input.baseDaemonEnvironment,
    ...requiredDaemonEnvironment,
  };
  return {
    daemonEnvironment,
    setupProbe: async (event: ProductionFixtureSetupProbeEvent) => {
      await input.setupProbe?.(event);
      assertRequiredEnvironmentSafe(event.directory);
      Object.assign(daemonEnvironment, requiredDaemonEnvironment);
    },
  };
};

/** Decode only complete provider-captured SSE tool calls. The response gate
 * returns a real upstream body; this parser neither creates nor modifies it. */
export const decodeCapturedProviderToolCalls = (
  responseBodyBase64: string,
): ReadonlyArray<CapturedProviderToolCall> => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(responseBodyBase64)) {
    throw new Error("captured Provider response is not valid base64");
  }
  const responseText = Buffer.from(responseBodyBase64, "base64").toString(
    "utf8",
  );
  const fragments = new Map<string, { name: string; argumentsText: string }>();
  const absorb = (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    const choices = (value as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) return;
    for (const [choiceOffset, rawChoice] of choices.entries()) {
      if (typeof rawChoice !== "object" || rawChoice === null) continue;
      const choice = rawChoice as {
        index?: unknown;
        delta?: { tool_calls?: unknown };
        message?: { tool_calls?: unknown };
      };
      const choiceIndex =
        typeof choice.index === "number" && Number.isInteger(choice.index)
          ? choice.index
          : choiceOffset;
      const calls = choice.delta?.tool_calls ?? choice.message?.tool_calls;
      if (!Array.isArray(calls)) continue;
      for (const [callOffset, rawCall] of calls.entries()) {
        if (typeof rawCall !== "object" || rawCall === null) continue;
        const call = rawCall as {
          index?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        };
        const callIndex =
          typeof call.index === "number" && Number.isInteger(call.index)
            ? call.index
            : callOffset;
        const key = `${choiceIndex}:${callIndex}`;
        const fragment = fragments.get(key) ?? {
          name: "",
          argumentsText: "",
        };
        if (typeof call.function?.name === "string") {
          fragment.name += call.function.name;
        }
        if (typeof call.function?.arguments === "string") {
          fragment.argumentsText += call.function.arguments;
        } else if (call.function?.arguments !== undefined) {
          fragment.argumentsText += JSON.stringify(call.function.arguments);
        }
        fragments.set(key, fragment);
      }
    }
  };

  for (const line of responseText.split(/\r?\n/u)) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") continue;
    try {
      absorb(JSON.parse(data) as unknown);
    } catch {
      throw new Error("captured Provider SSE contains invalid JSON data");
    }
  }
  return [...fragments.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, fragment]) => {
      if (fragment.name.length === 0 || fragment.argumentsText.length === 0) {
        throw new Error("captured Provider tool call is incomplete");
      }
      let parsedArguments: unknown;
      try {
        parsedArguments = JSON.parse(fragment.argumentsText) as unknown;
      } catch {
        throw new Error("captured Provider tool-call arguments are invalid");
      }
      if (
        typeof parsedArguments !== "object" ||
        parsedArguments === null ||
        Array.isArray(parsedArguments)
      ) {
        throw new Error(
          "captured Provider tool-call arguments are not an object",
        );
      }
      return {
        name: fragment.name,
        arguments: parsedArguments as Readonly<Record<string, unknown>>,
      };
    });
};

const CONFIG_PATH_ENV = "ARBOR_PUBLIC_S1_CONFIG";
const CAPTURE_FILE_ENV = "ARBOR_PUBLIC_S1_CAPTURE_FILE";
const CAPTURE_ENDPOINT_ENV = "ARBOR_PUBLIC_S1_CAPTURE_ENDPOINT";
const EVIDENCE_ROOT_ENV = "ARBOR_PUBLIC_REAL_EVIDENCE_ROOT";
const repositoryRoot = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

const isWithinDirectory = (parent: string, candidate: string): boolean => {
  const rel = relative(parent, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
};

export type EvidenceRootReadiness =
  | { readonly ready: true; readonly path: string }
  | { readonly ready: false; readonly reason: string };

export const validateRealJourneyEvidenceRoot = (
  configuredPath = process.env[EVIDENCE_ROOT_ENV],
  worktreeRoot = repositoryRoot,
): EvidenceRootReadiness => {
  if (configuredPath === undefined || configuredPath.trim().length === 0) {
    return {
      ready: false,
      reason: `set ${EVIDENCE_ROOT_ENV} to this worktree's existing .test-results directory or a descendant; each journey creates a P39-private run directory`,
    };
  }
  try {
    const canonicalWorktree = resolve(worktreeRoot);
    const resultsRoot = resolve(canonicalWorktree, ".test-results");
    const requested = resolve(canonicalWorktree, configuredPath);
    if (
      (requested !== resultsRoot &&
        !isWithinDirectory(resultsRoot, requested)) ||
      !existsSync(requested)
    ) {
      return {
        ready: false,
        reason:
          "evidence root must be an existing descendant of this worktree's .test-results",
      };
    }
    if (!lstatSync(requested).isDirectory()) {
      return { ready: false, reason: "evidence root must be a directory" };
    }
    const relativeRoot = relative(canonicalWorktree, requested);
    let cursor = canonicalWorktree;
    for (const segment of relativeRoot.split(sep)) {
      cursor = join(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) {
        return {
          ready: false,
          reason: "evidence root may not traverse a symlink or reparse point",
        };
      }
    }
    const canonicalResultsRoot = realpathSync(resultsRoot);
    const canonicalRequested = realpathSync(requested);
    if (
      canonicalRequested !== canonicalResultsRoot &&
      !isWithinDirectory(canonicalResultsRoot, canonicalRequested)
    ) {
      return {
        ready: false,
        reason: "evidence root resolves outside this worktree's .test-results",
      };
    }
    return { ready: true, path: requested };
  } catch {
    return {
      ready: false,
      reason: "evidence root is unavailable or cannot be safely canonicalized",
    };
  }
};

export const discoverProductionProviderConfig = (): RealProviderReadiness => {
  try {
    const configPath =
      process.env[CONFIG_PATH_ENV]?.trim() ||
      process.env.ARBOR_CONFIG?.trim() ||
      (existsSync("C:\\Arbor\\arbor.config.json")
        ? "C:\\Arbor\\arbor.config.json"
        : undefined);
    const previousConfigPath = process.env.ARBOR_CONFIG;
    let found: ReturnType<typeof findArborConfigFile>;
    try {
      if (configPath !== undefined)
        process.env.ARBOR_CONFIG = resolve(configPath);
      found = findArborConfigFile();
    } finally {
      if (configPath !== undefined) {
        if (previousConfigPath === undefined) delete process.env.ARBOR_CONFIG;
        else process.env.ARBOR_CONFIG = previousConfigPath;
      }
    }
    if (found === undefined) {
      return {
        ready: false,
        reason: "production arbor.config.json was not found",
      };
    }
    if (!found.ok) {
      return { ready: false, reason: "production provider config is invalid" };
    }
    const provider = found.config.provider;
    const secretKind = provider.secret?.kind;
    const missing: Array<string> = [];
    if (provider.deploymentId.trim().length === 0) missing.push("deploymentId");
    if (provider.modelRef.trim().length === 0) missing.push("modelRef");
    if (
      provider.endpoint?.trim().length === 0 ||
      provider.endpoint === undefined
    ) {
      missing.push("endpoint");
    }
    if (
      provider.wireModelName?.trim().length === 0 ||
      provider.wireModelName === undefined
    ) {
      missing.push("wireModelName");
    }
    if (
      secretKind !== "env" &&
      secretKind !== "file" &&
      secretKind !== "inline"
    ) {
      missing.push("SecretStore-backed provider.secret");
    }
    if (missing.length > 0) {
      return {
        ready: false,
        reason: `production config missing ${missing.join(", ")}`,
      };
    }
    const endpoint = provider.endpoint as string;
    const parsedEndpoint = new URL(endpoint);
    if (
      parsedEndpoint.protocol !== "https:" &&
      parsedEndpoint.protocol !== "http:"
    ) {
      return {
        ready: false,
        reason: "production provider endpoint must use HTTP(S)",
      };
    }
    return {
      ready: true,
      config: {
        path: resolve(found.path),
        deploymentId: provider.deploymentId,
        modelRef: provider.modelRef,
        endpoint,
        wireModelName: provider.wireModelName as string,
        secretKind: secretKind as RealProviderConfig["secretKind"],
      },
    };
  } catch {
    // Parser errors may include config values; keep readiness diagnostics value-free.
    return {
      ready: false,
      reason: "production provider config could not be resolved",
    };
  }
};

const safeEndpoint = (endpoint: string): string => {
  const parsed = new URL(endpoint);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

const fetchHook = fileURLToPath(
  new URL("./provider-fetch-capture-hook.mjs", import.meta.url),
);

/** Starts only the production daemon with its configured real provider.
 * The local scripted-provider endpoint is a fail-closed tripwire, never a fallback. */
export const startRealProviderFixture = async (input: {
  readonly config: RealProviderConfig;
  readonly evidenceRoot: string;
  readonly journeyId: string;
  readonly responseGate?: boolean;
  readonly requiredDaemonEnvironment?: Record<string, string>;
  readonly setupProbe?: (
    event: ProductionFixtureSetupProbeEvent,
  ) => void | Promise<void>;
  readonly onProviderStarted?: (fixture: ProductionFixture) => void;
}): Promise<StartedRealProviderFixture> => {
  const evidenceRoot = validateRealJourneyEvidenceRoot(input.evidenceRoot);
  if (!evidenceRoot.ready) {
    throw new Error(`REAL NOT QUALIFIED: ${evidenceRoot.reason}`);
  }
  const safeJourneyId = input.journeyId
    .replace(/[^A-Za-z0-9_-]/gu, "-")
    .slice(0, 80);
  const privateRunDirectory = makeP39PrivateTestDirectory(
    evidenceRoot.path,
    `real-public-${safeJourneyId}-`,
  );
  const resultsRoot = realpathSync.native(
    resolve(repositoryRoot, ".test-results"),
  );
  const runPathFromResults = relative(resultsRoot, privateRunDirectory);
  const ownsArchiveResultDirectory =
    runPathFromResults === "" ||
    runPathFromResults === ".." ||
    runPathFromResults.startsWith(`..${sep}`) ||
    runPathFromResults.includes(sep);
  const archiveResultDirectory = ownsArchiveResultDirectory
    ? makeP39PrivateTestDirectory(resultsRoot, "real-public-fixture-archive-")
    : privateRunDirectory;
  const evidenceDirectory = makeP39PrivateTestDirectory(
    privateRunDirectory,
    "evidence-",
  );
  const responseGateDirectory = input.responseGate
    ? makeP39PrivateTestDirectory(evidenceDirectory, "response-gate-")
    : undefined;
  const captureFile = join(evidenceDirectory, "provider-captures.jsonl");
  createP39PrivateTestFile(captureFile);
  const previousCapturePath = process.env[CAPTURE_FILE_ENV];
  let fixture: ProductionFixture | undefined;
  const daemonSetup = createRealProviderFixtureDaemonSetup({
    baseDaemonEnvironment: {
      ARBOR_CONFIG: input.config.path,
      ARBOR_MODEL_BASE_URL: "",
      ARBOR_MODEL_NAME: "",
      ARBOR_MODEL_API_KEY_VAR: "",
      [CAPTURE_ENDPOINT_ENV]: safeEndpoint(input.config.endpoint),
      ...(responseGateDirectory === undefined
        ? {}
        : { ARBOR_PUBLIC_S1_RESPONSE_GATE_DIR: responseGateDirectory }),
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(fetchHook).href}`.trim(),
    },
    ...(input.requiredDaemonEnvironment === undefined
      ? {}
      : { requiredDaemonEnvironment: input.requiredDaemonEnvironment }),
    ...(input.setupProbe === undefined ? {} : { setupProbe: input.setupProbe }),
  });
  try {
    process.env[CAPTURE_FILE_ENV] = captureFile;
    fixture = await startProductionFixture({
      admitWorkspaceDirectory: true,
      preserveDirectoryOnStop: true,
      reply: () => {
        throw new Error(
          "REAL NOT QUALIFIED: scripted provider endpoint received a request",
        );
      },
      daemonEnvironment: daemonSetup.daemonEnvironment,
      setupProbe: daemonSetup.setupProbe,
    });
  } catch (error) {
    const safeError = redactRealProviderDiagnostic(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    );
    const evidencePath = writeRealProviderStartupFailureEvidence({
      evidenceDirectory,
      captureFile,
      journeyId: input.journeyId,
      config: input.config,
      error: safeError,
    });
    throw new Error(
      `REAL NOT QUALIFIED: production fixture startup failed; private evidence retained at ${evidencePath}; ${safeError}`,
    );
  } finally {
    if (previousCapturePath === undefined) delete process.env[CAPTURE_FILE_ENV];
    else process.env[CAPTURE_FILE_ENV] = previousCapturePath;
  }
  if (fixture === undefined) {
    throw new Error(
      "REAL NOT QUALIFIED: production fixture returned no process handle",
    );
  }
  input.onProviderStarted?.(fixture);
  return {
    fixture,
    captureFile,
    evidenceDirectory,
    privateRunDirectory,
    archiveResultDirectory,
    ownsArchiveResultDirectory,
    ...(responseGateDirectory === undefined ? {} : { responseGateDirectory }),
  };
};

export const makeDeadlinePublicClient = (
  fixture: ProductionFixture,
  deadlineAt: number,
) => makePublicClient(fixture.baseUrl, { deadlineAt });

export const startedProviderRequests = (
  captures: ReadonlyArray<ProviderCapture>,
): ReadonlyArray<ProviderCapture> =>
  captures.filter((capture) => capture.event === "request-start");

export type ProviderRequestBodyEvent = Extract<
  ProviderCapture["event"],
  | "response-complete"
  | "response-held"
  | "response-released"
  | "response-capture-failed"
  | "request-failed"
>;

export interface BoundProviderRequestEvidence {
  readonly _tag: "Bound";
  readonly requestId: string;
  readonly request: Record<string, unknown>;
  readonly requestStart: ProviderCapture & { readonly event: "request-start" };
  readonly bodyEvents: ReadonlyArray<
    ProviderCapture & {
      readonly event: ProviderRequestBodyEvent;
      readonly request: Record<string, unknown>;
    }
  >;
}

export interface InvalidProviderRequestEvidence {
  readonly _tag: "Invalid";
  readonly requestId: string;
  readonly reason:
    | "MissingRequestStart"
    | "DuplicateRequestStart"
    | "RequestStartContainsBody"
    | "MissingRequestBody"
    | "DuplicateBodyEvent"
    | "ConflictingRequestBody"
    | "ConflictingRequestMetadata";
}

export type ProviderRequestEvidence =
  | BoundProviderRequestEvidence
  | InvalidProviderRequestEvidence;

const PROVIDER_REQUEST_BODY_EVENTS = new Set<ProviderRequestBodyEvent>([
  "response-complete",
  "response-held",
  "response-released",
  "response-capture-failed",
  "request-failed",
]);

/** Joins body-bearing Provider evidence to one exact bodyless request-start.
 * Ambiguous, duplicate, or conflicting evidence is returned as Invalid. */
export const providerRequestEvidence = (
  captures: ReadonlyArray<ProviderCapture>,
  requestId: string,
): ProviderRequestEvidence => {
  const matching = captures.filter(
    (capture) => capture.requestId === requestId,
  );
  const starts = matching.filter(
    (
      capture,
    ): capture is ProviderCapture & { readonly event: "request-start" } =>
      capture.event === "request-start",
  );
  if (starts.length === 0) {
    return { _tag: "Invalid", requestId, reason: "MissingRequestStart" };
  }
  if (starts.length !== 1) {
    return { _tag: "Invalid", requestId, reason: "DuplicateRequestStart" };
  }
  const requestStart = starts[0];
  if (requestStart === undefined || requestStart.request !== undefined) {
    return { _tag: "Invalid", requestId, reason: "RequestStartContainsBody" };
  }

  const bodyRecords = matching.filter((capture) =>
    PROVIDER_REQUEST_BODY_EVENTS.has(capture.event as ProviderRequestBodyEvent),
  );
  if (bodyRecords.some((capture) => capture.request === undefined)) {
    return { _tag: "Invalid", requestId, reason: "MissingRequestBody" };
  }
  if (bodyRecords.length === 0) {
    return { _tag: "Invalid", requestId, reason: "MissingRequestBody" };
  }
  const bodyEventCounts = new Map<string, number>();
  for (const capture of bodyRecords) {
    const count = (bodyEventCounts.get(capture.event) ?? 0) + 1;
    bodyEventCounts.set(capture.event, count);
    if (count > 1) {
      return { _tag: "Invalid", requestId, reason: "DuplicateBodyEvent" };
    }
  }

  const firstBody = bodyRecords[0];
  if (firstBody?.request === undefined) {
    return { _tag: "Invalid", requestId, reason: "MissingRequestBody" };
  }
  const canonicalBody = JSON.stringify(firstBody.request);
  for (const capture of bodyRecords) {
    if (
      capture.request === undefined ||
      JSON.stringify(capture.request) !== canonicalBody
    ) {
      return { _tag: "Invalid", requestId, reason: "ConflictingRequestBody" };
    }
    if (
      capture.processId !== requestStart.processId ||
      capture.sequence !== requestStart.sequence ||
      capture.method !== requestStart.method ||
      capture.path !== requestStart.path
    ) {
      return {
        _tag: "Invalid",
        requestId,
        reason: "ConflictingRequestMetadata",
      };
    }
  }
  return {
    _tag: "Bound",
    requestId,
    request: firstBody.request,
    requestStart,
    bodyEvents: bodyRecords as BoundProviderRequestEvidence["bodyEvents"],
  };
};

/** Identifies request IDs only from body-bearing event payloads, then requires
 * an exact, unambiguous request-start join for every selected Provider call. */
export const providerRequestsMatching = (
  captures: ReadonlyArray<ProviderCapture>,
  predicate: (request: Record<string, unknown>) => boolean,
): ReadonlyArray<ProviderRequestEvidence> => {
  const requestIds = new Set(
    captures
      .filter(
        (capture) =>
          PROVIDER_REQUEST_BODY_EVENTS.has(
            capture.event as ProviderRequestBodyEvent,
          ) &&
          capture.request !== undefined &&
          predicate(capture.request),
      )
      .map((capture) => capture.requestId),
  );
  return [...requestIds].map((requestId) =>
    providerRequestEvidence(captures, requestId),
  );
};

export const armProviderResponseGate = (
  run: StartedRealProviderFixture,
  selector?: ProviderResponseGateSelector,
): void => {
  if (run.responseGateDirectory === undefined) {
    throw new Error(
      "response gate was not enabled for this real-provider fixture",
    );
  }
  if (selector !== undefined) updateProviderResponseGateSelector(run, selector);
  createP39PrivateTestFile(join(run.responseGateDirectory, "armed"));
};

export const updateProviderResponseGateSelector = (
  run: StartedRealProviderFixture,
  selector: ProviderResponseGateSelector,
): void => {
  if (run.responseGateDirectory === undefined) {
    throw new Error(
      "response gate was not enabled for this real-provider fixture",
    );
  }
  const selectorPath = join(run.responseGateDirectory, "selector.json");
  const temporarySelectorPath = join(
    run.responseGateDirectory,
    `selector-${randomUUID()}.tmp`,
  );
  createP39PrivateTestFile(temporarySelectorPath);
  try {
    writeFileSync(temporarySelectorPath, `${JSON.stringify(selector)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporarySelectorPath, selectorPath);
  } catch (error) {
    try {
      rmSync(temporarySelectorPath, { force: true });
    } catch {
      // Preserve the selector update failure; this is a disposable private gate path.
    }
    throw error;
  }
};

export const releaseProviderResponse = (
  run: StartedRealProviderFixture,
  requestId: string,
): void => {
  if (
    run.responseGateDirectory === undefined ||
    !/^[0-9a-f-]{36}$/iu.test(requestId)
  ) {
    throw new Error("invalid private response-gate release target");
  }
  createP39PrivateTestFile(
    join(run.responseGateDirectory, `release-${requestId}`),
  );
};

export const finishRealProviderFixture = async (
  run: StartedRealProviderFixture,
  requestedStatus: "PASS" | "FAIL",
): Promise<{
  readonly status: "PASS" | "FAIL";
  readonly error?: string;
  readonly fixtureRetained: boolean;
}> => {
  let status = requestedStatus;
  let error: string | undefined;
  try {
    await run.fixture.stop();
    if (!run.fixture.daemonsExited()) {
      throw new Error("fixture stop returned while a daemon remained alive");
    }
    if (status === "PASS")
      removeFunctionalFixtureDirectory(run.fixture.directory);
  } catch (failure) {
    status = "FAIL";
    error = redactRealProviderDiagnostic(
      failure instanceof Error ? failure.message : String(failure),
    );
  }
  if (
    status === "PASS" &&
    run.ownsArchiveResultDirectory &&
    readdirSync(run.archiveResultDirectory).length === 0
  ) {
    removeP39PrivateTestDirectory(run.archiveResultDirectory);
  }
  if (status === "FAIL" && run.fixture.daemonsExited()) {
    try {
      run.fixtureArchiveDirectory = archiveProductionFixtureFailure({
        fixture: run.fixture,
        resultDirectory: run.archiveResultDirectory,
        artifactPrefix: "retained-fixture",
        evidence: {
          schemaVersion: "arbor-real-public-fixture-failure-v1",
          status: "FAIL",
          captureFile: run.captureFile,
          evidenceDirectory: run.evidenceDirectory,
          daemonExited: run.fixture.daemonsExited(),
          daemonErrors: run.fixture.daemonErrors.map(
            redactRealProviderDiagnostic,
          ),
        },
      });
    } catch (failure) {
      const archiveError = redactRealProviderDiagnostic(
        failure instanceof Error ? failure.message : String(failure),
      );
      error = error === undefined ? archiveError : `${error}; ${archiveError}`;
    }
  }
  return {
    status,
    ...(error === undefined ? {} : { error }),
    fixtureRetained:
      status === "FAIL" &&
      run.fixtureArchiveDirectory !== undefined &&
      existsSync(run.fixtureArchiveDirectory),
  };
};

export const writeRealProviderEvidence = (input: {
  readonly run: StartedRealProviderFixture;
  readonly journeyId: string;
  readonly config: RealProviderConfig;
  readonly status: "PASS" | "FAIL";
  readonly state: unknown;
  readonly error?: string;
}): string => {
  const outputPath = join(
    input.run.evidenceDirectory,
    `${input.journeyId}-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  createP39PrivateTestFile(outputPath);
  writeFileSync(
    `${outputPath}`,
    `${JSON.stringify(
      {
        schemaVersion: "arbor-real-public-journey-evidence-v1",
        journeyId: input.journeyId,
        recordedAt: new Date().toISOString(),
        status: input.status,
        providerMode: "REAL",
        provider: {
          configPath: input.config.path,
          deploymentId: input.config.deploymentId,
          modelRef: input.config.modelRef,
          wireModelName: input.config.wireModelName,
          secretStoreKind: input.config.secretKind,
          credentialsRecorded: false,
        },
        fixture: {
          directory:
            input.run.fixtureArchiveDirectory ?? input.run.fixture.directory,
          databaseFile: input.run.fixtureArchiveDirectory
            ? join(
                input.run.fixtureArchiveDirectory,
                basename(input.run.fixture.databaseFile),
              )
            : input.run.fixture.databaseFile,
          workspaceDirectory: input.run.fixtureArchiveDirectory
            ? join(
                input.run.fixtureArchiveDirectory,
                basename(input.run.fixture.workspaceDirectory),
              )
            : input.run.fixture.workspaceDirectory,
          daemonExited: input.run.fixture.daemonsExited(),
          daemonErrors: input.run.fixture.daemonErrors.map(
            redactRealProviderDiagnostic,
          ),
        },
        captureFile: input.run.captureFile,
        captures: readProviderCaptures(input.run.captureFile),
        state: input.state,
        ...(input.error === undefined
          ? {}
          : { error: redactRealProviderDiagnostic(input.error) }),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return outputPath;
};

export const writeRealProviderStartupFailureEvidence = (input: {
  readonly evidenceDirectory: string;
  readonly captureFile: string;
  readonly journeyId: string;
  readonly config: RealProviderConfig;
  readonly error: string;
}): string => {
  const outputPath = join(
    input.evidenceDirectory,
    `${input.journeyId}-startup-failure-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  createP39PrivateTestFile(outputPath);
  writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        schemaVersion: "arbor-real-public-journey-evidence-v1",
        journeyId: input.journeyId,
        recordedAt: new Date().toISOString(),
        status: "FAIL",
        providerMode: "REAL",
        provider: {
          configPath: input.config.path,
          deploymentId: input.config.deploymentId,
          modelRef: input.config.modelRef,
          wireModelName: input.config.wireModelName,
          secretStoreKind: input.config.secretKind,
          credentialsRecorded: false,
        },
        fixture: null,
        captureFile: input.captureFile,
        captures: readProviderCaptures(input.captureFile),
        error: redactRealProviderDiagnostic(input.error),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return outputPath;
};

export const redactRealProviderDiagnostic = (text: string): string =>
  text
    .replace(/bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/gu, "[REDACTED]")
    .replace(
      /((?:api[_-]?key|secret|credential|token)["']?\s*[:=]\s*["']?)[^"'\s,;]+/giu,
      "$1[REDACTED]",
    )
    .slice(0, 8_000);

export const repositoryBuildAssets = (): ReadonlyArray<string> => {
  const repositoryRoot = resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
  );
  return [
    [
      "apps/single-workspace/dist/main.js",
      resolve(repositoryRoot, "apps/single-workspace/dist/main.js"),
    ],
    [
      "apps/web/dist/index.html",
      resolve(repositoryRoot, "apps/web/dist/index.html"),
    ],
  ]
    .filter(([, path]) => !existsSync(path as string))
    .map(([label]) => label as string);
};

export const captureWorkspaceSnapshot = (
  workspaceDirectory: string,
): WorkspaceFileSnapshot => {
  const entries: Record<string, WorkspaceFileSnapshot["entries"][string]> = {};
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolutePath = join(directory, name);
      const relativePath =
        relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`workspace snapshot refuses symlink ${relativePath}`);
      }
      if (stat.isDirectory()) {
        entries[relativePath] = { kind: "directory" };
        visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        const bytes = readFileSync(absolutePath);
        entries[relativePath] = {
          kind: "file",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytesBase64: bytes.toString("base64"),
        };
      } else {
        throw new Error(
          `workspace snapshot refuses non-file entry ${relativePath}`,
        );
      }
    }
  };
  visit(workspaceDirectory, "");
  return { entries };
};
