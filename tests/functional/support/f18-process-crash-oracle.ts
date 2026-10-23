export interface F18ProcessCrashMarker {
  readonly boundary: string;
  readonly projectId: string;
  readonly eventSequence: number;
  readonly leaseGeneration: number;
}

export const f18ProcessCrashMarker = (input: F18ProcessCrashMarker): string =>
  `F18_TEST_CRASH:${input.boundary}:${input.projectId}:${input.eventSequence}:${input.leaseGeneration}`;

export const hasExpectedF18ProcessCrash = (input: {
  readonly exitCode: number | null | undefined;
  readonly daemonErrors: ReadonlyArray<string>;
  readonly marker: string;
}): boolean =>
  input.exitCode === 86 &&
  input.daemonErrors.some((message) => message.includes(input.marker));

export const unexpectedF18DaemonErrors = (
  daemonErrors: ReadonlyArray<string>,
  expectedMarker: string,
): ReadonlyArray<string> =>
  daemonErrors
    .map((message) => message.replaceAll(expectedMarker, "").trim())
    .filter((message) => message.length > 0);
