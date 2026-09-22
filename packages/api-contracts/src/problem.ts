/** DID §10.5 Problem — the external presentation DTO. Consumers rely on the
 * stable `code`, never parse `message`. Problem is an outward protocol only
 * and must not become a universal internal error type. */
export interface Problem {
  readonly code: string;
  readonly category: string;
  readonly message: string;
  readonly correlationId: string | null;
  readonly retryDisposition: string;
  readonly safeDetails: Readonly<Record<string, unknown>>;
}
