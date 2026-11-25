/** Shared value types used by sandbox policy producers and result views.
 * Keeping these structural types independent prevents the producer/result
 * codecs from importing each other merely to share a field shape. */
export interface SandboxPolicyLimitsV1 {
  readonly wallTimeMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly processCount: number;
  readonly memoryBytes: number;
  readonly cpuTimeMs: number;
}
