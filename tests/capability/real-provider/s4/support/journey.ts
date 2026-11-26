// Shared REAL S4 journey harness (B5 split): module-level qualification
// readiness, deadline client helpers, fixture lifecycle and transcript
// oracles. Bodies are moved verbatim from the former monolithic
// public-s4-recovery.test.ts.
import { isAbsolute, relative, resolve } from "node:path";
import { afterEach, expect } from "vitest";
import type {
  ProductionFixture,
  ProductionFixtureSetupProbeEvent,
} from "../../../../functional/support/production-fixture.js";
import { waitForPublic } from "../../../../functional/support/public-client.js";
import {
  type BoundProviderRequestEvidence,
  discoverProductionProviderConfig,
  finishRealProviderFixture,
  type makeDeadlinePublicClient,
  type ProviderCapture,
  type ProviderRequestEvidence,
  repositoryBuildAssets,
  type StartedRealProviderFixture,
  startRealProviderFixture,
  validateRealJourneyEvidenceRoot,
  writeRealProviderEvidence,
} from "../../public-real-journey-support.js";

const OPT_IN_ENV = "ARBOR_RUN_REAL_PUBLIC_S4";
const CAPTURE_FILE_ENV = "ARBOR_PUBLIC_S1_CAPTURE_FILE";
const RESPONSE_GATE_DIRECTORY_ENV = "ARBOR_PUBLIC_S1_RESPONSE_GATE_DIR";
const JOURNEY_BUDGET_MS = 20 * 60_000;

export interface TranscriptEntry {
  readonly kind: string;
  readonly body?: string;
  readonly messageId?: string;
  readonly responseStatus?: {
    readonly state: string;
    readonly reason?: string;
    readonly revision?: number;
  };
}

export interface TranscriptPage {
  readonly entries: ReadonlyArray<TranscriptEntry>;
}

const explicitConfigPath =
  process.env.ARBOR_PUBLIC_S1_CONFIG?.trim() ||
  process.env.ARBOR_CONFIG?.trim();
const readiness = discoverProductionProviderConfig();
const evidenceRootReadiness = validateRealJourneyEvidenceRoot();
const missingAssetsAtLoad = repositoryBuildAssets();
const skipReason =
  process.env[OPT_IN_ENV] !== "1"
    ? `set ${OPT_IN_ENV}=1 to explicitly opt in`
    : readiness.ready
      ? explicitConfigPath === undefined
        ? "set ARBOR_PUBLIC_S1_CONFIG to the authorized Provider config path"
        : readiness.config.path.toLowerCase() !==
            resolve(explicitConfigPath).toLowerCase()
          ? "resolved Provider config path does not match the explicit test path"
          : !evidenceRootReadiness.ready
            ? evidenceRootReadiness.reason
            : missingAssetsAtLoad.length > 0
              ? `build ${missingAssetsAtLoad.join(", ")} before qualification`
              : undefined
      : readiness.reason;

const activeFixtures: Array<ProductionFixture> = [];
afterEach(async () => {
  for (const fixture of activeFixtures.splice(0)) await fixture.stop();
});

const transcript = (
  client: ReturnType<typeof makeDeadlinePublicClient>,
  workspaceId: string,
) =>
  client.view<TranscriptPage>("transcript", {
    workspaceId,
    conversationOnly: true,
    limit: 20,
  });

const waitWithinDeadline = async <A>(input: {
  readonly deadlineAt: number;
  readonly read: () => Promise<A>;
  readonly predicate: (value: A) => boolean;
  readonly label: string;
  readonly timeoutMs?: number;
}): Promise<A> => {
  const timeoutMs = Math.min(
    input.timeoutMs ?? 90_000,
    input.deadlineAt - Date.now(),
  );
  if (timeoutMs <= 0)
    throw new Error(`S4 deadline expired before ${input.label}`);
  try {
    return await waitForPublic(input.read, input.predicate, timeoutMs);
  } catch {
    throw new Error(
      `S4 public state did not reach ${input.label} before deadline`,
    );
  }
};

const entryKey = (entry: TranscriptEntry): string =>
  `${entry.kind}:${entry.messageId ?? entry.body ?? "missing-identity"}`;

const requestText = (request: Record<string, unknown>): string =>
  JSON.stringify(request);

const workspaceWorkProviderRequestIds = (
  captures: ReadonlyArray<ProviderCapture>,
  marker: string,
): ReadonlyArray<string> =>
  [
    ...new Set(
      captures
        .filter(
          (capture) =>
            capture.event === "response-complete" &&
            capture.request !== undefined &&
            requestText(capture.request).includes(marker) &&
            requestText(capture.request).includes(
              "In a WorkspaceWork turn bound to a current Work",
            ),
        )
        .map((capture) => capture.requestId),
    ),
  ].sort();

const requireBoundProviderRequests = (
  evidence: ReadonlyArray<ProviderRequestEvidence>,
  context: string,
): ReadonlyArray<BoundProviderRequestEvidence> => {
  const invalid = evidence.find((candidate) => candidate._tag === "Invalid");
  if (invalid !== undefined) {
    throw new Error(
      `S4 ${context} Provider request evidence is ambiguous: ${invalid.reason}`,
    );
  }
  return evidence.filter(
    (candidate): candidate is BoundProviderRequestEvidence =>
      candidate._tag === "Bound",
  );
};

const isStrictlyInside = (parent: string, child: string): boolean => {
  const rel = relative(resolve(parent), resolve(child));
  return (
    rel.length > 0 &&
    rel !== ".." &&
    !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(rel)
  );
};

const assertPrivateFixturePaths = (fixture: ProductionFixture): void => {
  expect(isStrictlyInside(fixture.directory, fixture.databaseFile)).toBe(true);
  expect(isStrictlyInside(fixture.directory, fixture.workspaceDirectory)).toBe(
    true,
  );
  expect(isStrictlyInside("C:\\Arbor", fixture.databaseFile)).toBe(false);
  expect(isStrictlyInside("C:\\Arbor", fixture.workspaceDirectory)).toBe(false);
};

const sanitizeErrorKind = (error: unknown): string =>
  error instanceof Error ? error.name.slice(0, 80) : "UnknownFailure";

const withRealFixture = async <A>(input: {
  readonly caseId: string;
  readonly responseGate?: boolean;
  readonly requiredDaemonEnvironment?: Record<string, string>;
  readonly setupProbe?: (
    event: ProductionFixtureSetupProbeEvent,
  ) => void | Promise<void>;
  readonly body: (
    run: StartedRealProviderFixture,
    deadlineAt: number,
  ) => Promise<A>;
}): Promise<A> => {
  if (!readiness.ready)
    throw new Error("REAL NOT QUALIFIED: provider config is unavailable");
  if (!evidenceRootReadiness.ready) {
    throw new Error("REAL NOT QUALIFIED: private evidence root is unavailable");
  }
  const run = await startRealProviderFixture({
    config: readiness.config,
    evidenceRoot: evidenceRootReadiness.path,
    journeyId: input.caseId,
    ...(input.responseGate === true ? { responseGate: true } : {}),
    ...(input.requiredDaemonEnvironment === undefined
      ? {}
      : { requiredDaemonEnvironment: input.requiredDaemonEnvironment }),
    ...(input.setupProbe === undefined ? {} : { setupProbe: input.setupProbe }),
  });
  activeFixtures.push(run.fixture);
  const deadlineAt = Date.now() + JOURNEY_BUDGET_MS;
  let status: "PASS" | "FAIL" = "FAIL";
  let result: A | undefined;
  let caught: unknown;
  let scenario: Readonly<Record<string, unknown>> = {};
  let finalized:
    | Awaited<ReturnType<typeof finishRealProviderFixture>>
    | undefined;
  try {
    result = await input.body(run, deadlineAt);
    if (typeof result === "object" && result !== null) {
      scenario = result as Readonly<Record<string, unknown>>;
    }
    status = "PASS";
  } catch (error) {
    caught = error;
    scenario = { ...scenario, failureKind: sanitizeErrorKind(error) };
  } finally {
    finalized = await finishRealProviderFixture(run, status);
    writeRealProviderEvidence({
      run,
      journeyId: input.caseId,
      config: readiness.config,
      status: finalized.status,
      state: scenario,
      ...(finalized.error === undefined
        ? caught === undefined
          ? {}
          : { error: sanitizeErrorKind(caught) }
        : { error: finalized.error }),
    });
    activeFixtures.splice(activeFixtures.indexOf(run.fixture), 1);
  }
  if (caught !== undefined) throw caught;
  if (finalized?.status !== "PASS") {
    throw new Error(
      "REAL public S4 fixture cleanup did not complete successfully",
    );
  }
  return result as A;
};

const publicWorkDetail = async (
  client: ReturnType<typeof makeDeadlinePublicClient>,
  projectId: string,
  workspaceId: string,
  workId: string,
) =>
  client.view<{
    workId: string;
    workspaceId: string;
    lifecycle: string;
    revision: number;
  }>("work-detail", { projectId, workspaceId, workId });

const publicStateOracle = "PublicCommandsAndViewsAndWorkspaceArtifact" as const;

export {
  assertPrivateFixturePaths,
  CAPTURE_FILE_ENV,
  entryKey,
  isStrictlyInside,
  JOURNEY_BUDGET_MS,
  publicStateOracle,
  publicWorkDetail,
  RESPONSE_GATE_DIRECTORY_ENV,
  requestText,
  requireBoundProviderRequests,
  skipReason,
  transcript,
  waitWithinDeadline,
  withRealFixture,
  workspaceWorkProviderRequestIds,
};
