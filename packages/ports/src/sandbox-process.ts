import type {
  ExecutionEpisodeBinding,
  ExecutionId,
  NetworkPolicyV1,
  SandboxBoundary,
  SandboxProfile,
  SandboxProviderCapability,
  SandboxProviderId,
  ToolInvocationId,
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
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly sandboxHandleId: string;
  readonly policyRevision: number;
  readonly expiresAt?: string;
  readonly profile: SandboxProfile;
  readonly providerId: SandboxProviderId;
  readonly providerVersion: string;
  readonly capabilityRevision: string;
  readonly boundary: SandboxBoundary;
  readonly networkPolicy: NetworkPolicyV1;
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
  readonly timeoutMs: number;
  readonly ambientEnvironment: NodeJS.ProcessEnv;
}

export type SandboxProcessInvocation = Omit<
  SandboxProcessRequest,
  "policy" | "handle" | "timeoutMs"
> & { readonly requestedTimeoutMs?: number };

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
      readonly providerId: SandboxProviderId;
      readonly providerVersion: string;
      readonly capabilityRevision: string;
      readonly probeEvidenceRef: string | null;
      readonly failureCode: string;
    }
  | {
      readonly _tag: "Rejected";
      readonly failureCode:
        | "PolicyMissing"
        | "ExecutionBindingMismatch"
        | "EpisodeBindingMismatch"
        | "HandleBindingMismatch"
        | "MountBindingMismatch"
        | "InvalidTimeout"
        | "ProcessCapabilityNotBound"
        | "ProviderOutcomeMismatch";
    };

export interface SandboxProviderUnavailableOutcome {
  readonly _tag: "SandboxProviderUnavailable";
  readonly projectId: import("@arbor/domain").ProjectId;
  readonly workspaceId: import("@arbor/domain").WorkspaceId;
  readonly executionId: ExecutionId;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly policyRevision: number;
  readonly policyDigest: string;
  readonly profileId: SandboxProfile;
  readonly providerId: SandboxProviderId;
  readonly providerVersion: string;
  readonly capabilityRevision: string;
  readonly probeEvidenceRef: string | null;
  readonly failureCode: string;
  readonly actionBinding: {
    readonly identity: {
      readonly executionId: ExecutionId;
      readonly logicalStepNo: number;
      readonly repairAttempt: number;
    };
    readonly providerTurnId: import("@arbor/domain").ProviderTurnId;
    readonly logicalActionId: string;
    readonly actionIndex: number;
    readonly callRef: string;
    readonly invocationId: ToolInvocationId;
  };
}

/** Internal P4 handoff after a durable exact intent/binding but before effect
 * admission. It is never a ToolObservation or persisted P40 settlement. */
export interface SandboxPolicyRequiredInterruption {
  readonly _tag: "SandboxPolicyRequiredInterruption";
}

export type SandboxProcessRunnerOutcome =
  | Extract<SandboxProcessOutcome, { readonly _tag: "Completed" }>
  | Extract<SandboxProcessOutcome, { readonly _tag: "Rejected" }>
  | SandboxProviderUnavailableOutcome;

export type SandboxProcessRunner = (
  invocation: SandboxProcessInvocation,
) => Effect.Effect<SandboxProcessRunnerOutcome>;

export type SandboxProcessProviderOutcome = Exclude<
  SandboxProcessOutcome,
  { readonly _tag: "Rejected" }
>;

export interface SandboxProcessPortService {
  readonly capabilities: () => Effect.Effect<
    ReadonlyArray<SandboxProviderCapability>,
    never
  >;
  readonly run: (
    request: SandboxProcessRequest,
  ) => Effect.Effect<SandboxProcessProviderOutcome>;
}

export class SandboxProcessPort extends Context.Service<
  SandboxProcessPort,
  SandboxProcessPortService
>()("arbor/SandboxProcessPort") {}
