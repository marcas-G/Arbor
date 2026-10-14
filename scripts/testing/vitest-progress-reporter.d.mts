export interface SerializedProgressError {
  readonly name: string | null;
  readonly type: string;
  readonly message: string | null;
  readonly stack: string | null;
  readonly ownProperties: Record<string, unknown>;
  readonly inspect: string;
  readonly string: string;
}

export interface VitestProgressOptions {
  readonly outputDirectory?: string;
  readonly jsonName?: string;
  readonly markdownName?: string;
  readonly profile?: string;
  readonly basename?: string;
}

export function serializeErrorForReport(
  error: unknown,
): SerializedProgressError;
export function normalizeVitestJsonReport<T>(report: T, progress: unknown): T;
export function redactTextForOutput(value: unknown): string;

export default class VitestProgressReporter {
  constructor(options?: VitestProgressOptions);
  onInit(): void;
  onTestRunStart(): void;
  onTestModuleStart(module: unknown): void;
  onTestModuleEnd(module: unknown): void;
  onTestCaseReady(testCase: unknown): void;
  onTestCaseResult(testCase: unknown): void;
  onTestRunEnd(
    modules: unknown,
    unhandledErrors: unknown[],
    reason: string,
  ): void;
}
