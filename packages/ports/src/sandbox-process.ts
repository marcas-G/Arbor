import type {
  ExecutionEpisodeBinding,
  ExecutionId,
  SandboxBoundary,
  SandboxNetworkMode,
  SandboxProfile,
  SandboxProviderCapability,
  SandboxProviderId,
} from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { SandboxHandle, SandboxMountAccess } from "./tool.js";

export interface SandboxProcessLimits {
  readonly wallTimeMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly processCount: number;
  readonly memoryBytes: number;
  readonly cpuTimeMs: number;
}

export interface SandboxProcessPolicy {
  readonly executionId: ExecutionId;
  readonly episodeBinding: ExecutionEpisodeBinding | null;
  readonly sandboxHandleId: string;
  readonly profile: SandboxProfile;
  readonly providerId: SandboxProviderId;
  readonly boundary: SandboxBoundary;
  readonly networkMode: SandboxNetworkMode;
  readonly policyDigest: string;
  readonly admittedMounts: ReadonlyArray<{
    readonly ref: string;
    readonly rootPath: string;
    readonly access: SandboxMountAccess;
  }>;
  readonly environmentAllowlist: ReadonlyArray<string>;
  readonly limits: SandboxProcessLimits;
  readonly auditRefs: ReadonlyArray<string>;
}

export interface SandboxProcessRequest {
  readonly policy: SandboxProcessPolicy;
  readonly handle: SandboxHandle;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: { readonly mount: string; readonly path: string };
  readonly ambientEnvironment: NodeJS.ProcessEnv;
}

export type SandboxProcessInvocation = Omit<
  SandboxProcessRequest,
  "policy" | "handle"
>;

export type SandboxProcessRunner = (
  invocation: SandboxProcessInvocation,
) => Effect.Effect<SandboxProcessOutcome>;

export type SandboxProcessOutcome =
  | {
      readonly _tag: "Completed";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly timedOut: boolean;
      readonly truncated: boolean;
    }
  | {
      readonly _tag: "Unavailable";
      readonly failureCode: string;
    };

export interface SandboxProcessPortService {
  readonly capabilities: () => Effect.Effect<
    ReadonlyArray<SandboxProviderCapability>,
    never
  >;
  readonly run: (
    request: SandboxProcessRequest,
  ) => Effect.Effect<SandboxProcessOutcome>;
}

export class SandboxProcessPort extends Context.Service<
  SandboxProcessPort,
  SandboxProcessPortService
>()("arbor/SandboxProcessPort") {}
