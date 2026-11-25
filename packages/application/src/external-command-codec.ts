import {
  decodeSandboxNetworkPolicySelectionV1,
  isPersistentWorkspaceToolPermission,
} from "@arbor/domain";
import type { GrantPermissionPayload } from "./commands/grant-permission.js";
import type { AuthorizeWorkspaceSandboxPayload } from "./commands/workspace-sandbox-authorization.js";
import {
  decodeAgainstRule,
  isRecord,
} from "./external-command-codec/decode-rule.js";
import { payloadRules } from "./external-command-codec/payload-rules.js";
import {
  actor,
  id,
  literal,
  object,
  string,
} from "./external-command-codec/rules.js";
import {
  type CommandInputIssue,
  type DecodeCommandPayloadResult,
  EXTERNAL_WIRE_CODEC_VERSION,
  type ExternalCommandPayloadMap,
  type ExternalOriginPolicy,
  type RegisteredCommandType,
  type SemanticExternalCommand,
} from "./external-command-codec/types.js";

export {
  type CommandInputIssue,
  type CommandInputIssueRule,
  type DecodeCommandPayloadResult,
  EXTERNAL_WIRE_CODEC_VERSION,
  type ExternalCommandPayloadMap,
  type ExternalOriginPolicy,
  type RegisteredCommandType,
  type SemanticExternalCommand,
} from "./external-command-codec/types.js";

const externalOriginPolicies: Readonly<
  Record<RegisteredCommandType, ExternalOriginPolicy>
> = {
  CreateProject: "human/bootstrap",
  CreateChildWorkspace: "reject external",
  AssignWork: "reject external; agent-originated",
  RenameProject:
    "authenticated local human external governance; exact actor/principal and ProjectGovernanceAuthority; no Agent origin",
  CloseProject:
    "authenticated local human external governance; exact actor/principal and ProjectGovernanceAuthority; no Agent origin",
  SelectCurrentWork: "reject external; scheduler-originated",
  AdmitExecution: "reject external under P13 U-3",
  StopExecution: "human/parent external; runtime remains typed internal",
  SettleExecution: "reject external; ExecutionOrigin/RecoveryController",
  SendMessage: "reject external; agent-originated",
  DeliverMessage: "reject external; agent-originated",
  DeclareDependency: "reject external; producer Agent",
  ProduceDeliverable: "reject external; producer Agent",
  SatisfyDependency: "reject external; dependency coordinator",
  RecordDecision: "external human governance",
  ResolveControlApproval: "external human approval",
  ResolveExecutableApproval: "external human approval",
  SteerWork: "external human",
  AcceptWorkOutcome:
    "external root-parent/human; parent-agent remains typed internal",
  CompleteWork: "reject external",
  StartVerification: "reject external; Verification consumer/runtime",
  RecordVerificationEvidence: "reject external; Verification consumer/runtime",
  ConcludeVerification: "reject external; Verification consumer/runtime",
  RetryVerification: "external authenticated human",
  GrantPermission: "external only when P12 authority resolves the principal",
  DecideSandboxPolicy: "external human governance",
  AuthorizeWorkspaceSandbox: "external human governance",
  RevokeWorkspaceSandboxAuthorization: "external human governance",
  RevokePermission: "external only when P12 authority resolves the principal",
  SubmitHumanMessage: "external authenticated human",
  ResumeConversationResponse: "authenticated human external response retry",
  CancelConversationResponse:
    "authenticated human external response cancellation",
};

export interface CommandInputContract {
  readonly commandType: RegisteredCommandType;
  readonly externalWireCodecVersion: typeof EXTERNAL_WIRE_CODEC_VERSION;
  readonly externalOriginPolicy: ExternalOriginPolicy;
  readonly externalOriginAllowed: boolean;
  readonly decodePayload: (payload: unknown) => DecodeCommandPayloadResult;
  readonly decodeInternalPayload: (
    payload: unknown,
  ) => DecodeCommandPayloadResult;
}

export interface CommandInputContractRegistry {
  readonly commandTypes: ReadonlyArray<RegisteredCommandType>;
  readonly lookup: (commandType: string) => CommandInputContract | undefined;
}

const COMMAND_TYPES = Object.freeze(
  Object.keys(payloadRules) as RegisteredCommandType[],
);

export const makeCommandInputContractRegistry = (
  registeredHandlerTypes: ReadonlyArray<string> = COMMAND_TYPES,
): CommandInputContractRegistry => {
  const registeredSet = new Set(registeredHandlerTypes);
  const knownTypes = new Set<string>(COMMAND_TYPES);
  const requiredTypes = COMMAND_TYPES.filter(
    (commandType) =>
      commandType !== "ResolveControlApproval" &&
      commandType !== "ResolveExecutableApproval" &&
      commandType !== "AuthorizeWorkspaceSandbox" &&
      commandType !== "RevokeWorkspaceSandboxAuthorization",
  );
  if (
    registeredSet.size !== registeredHandlerTypes.length ||
    registeredHandlerTypes.some(
      (commandType) => !knownTypes.has(commandType),
    ) ||
    requiredTypes.some((commandType) => !registeredSet.has(commandType))
  ) {
    throw new Error(
      "command input contract registry does not match registered handlers",
    );
  }
  const contractTypes = Object.freeze(
    COMMAND_TYPES.filter((commandType) => registeredSet.has(commandType)),
  );
  const contracts = new Map<RegisteredCommandType, CommandInputContract>(
    contractTypes.map((commandType) => [
      commandType,
      {
        commandType,
        externalWireCodecVersion: EXTERNAL_WIRE_CODEC_VERSION,
        externalOriginPolicy: externalOriginPolicies[commandType],
        externalOriginAllowed:
          !externalOriginPolicies[commandType].startsWith("reject external"),
        decodePayload: (payload) =>
          decodeCommandPayloadForContract(commandType, payload),
        decodeInternalPayload: (payload) =>
          decodeCommandPayloadForContract(commandType, payload, "Internal"),
      },
    ]),
  );
  return {
    commandTypes: contractTypes,
    lookup: (commandType) =>
      contracts.get(commandType as RegisteredCommandType),
  };
};

export const CommandInputContractRegistry = makeCommandInputContractRegistry();

export interface ExternalCommandDecoder {
  readonly decode: <K extends RegisteredCommandType>(
    commandType: K,
    payload: unknown,
  ) => DecodeCommandPayloadResult<ExternalCommandPayloadMap[K]>;
  readonly decodeEnvelope: (envelope: unknown) => DecodeExternalCommandResult;
}

export type DecodedExternalCommandEnvelope = SemanticExternalCommand;

export type DecodeExternalCommandResult =
  | { readonly ok: true; readonly value: DecodedExternalCommandEnvelope }
  | { readonly ok: false; readonly issues: ReadonlyArray<CommandInputIssue> };

export const makeExternalCommandDecoder = (
  registry: CommandInputContractRegistry = CommandInputContractRegistry,
): ExternalCommandDecoder => ({
  decode: (commandType, payload) => {
    const contract = registry.lookup(commandType);
    if (contract === undefined) {
      return { ok: false, issues: [{ path: [], rule: "unsupported-command" }] };
    }
    return contract.decodePayload(payload) as DecodeCommandPayloadResult<
      ExternalCommandPayloadMap[typeof commandType]
    >;
  },
  decodeEnvelope: (envelope) => decodeEnvelopeWithRegistry(registry, envelope),
});

export const ExternalCommandDecoder = makeExternalCommandDecoder();

export const decodeCommandPayload = (
  commandType: RegisteredCommandType,
  payload: unknown,
): DecodeCommandPayloadResult<ExternalCommandPayloadMap[typeof commandType]> =>
  ExternalCommandDecoder.decode(commandType, payload);

/** Version-specific decoder used by receipt/replay qualification. SteerWork
 * v1 is frozen to the legacy guidance payload; the explicit operation union is
 * only valid under schema v2. The external command endpoint defaults to the
 * current v2 contract while retaining legacy-guidance compatibility. */
export const decodeCommandPayloadForSchemaVersion = (
  commandType: RegisteredCommandType,
  schemaVersion: "1" | "2",
  payload: unknown,
): DecodeCommandPayloadResult => {
  const decoded = decodeAgainstRule(payloadRules[commandType], payload);
  if (decoded.ok && commandType === "GrantPermission") {
    const input = decoded.value as GrantPermissionPayload;
    if (input.expiresAt === null && schemaVersion === "1") {
      return { ok: false, issues: [{ path: ["expiresAt"], rule: "type" }] };
    }
    return validateGrantPermissionLifetime(input, decoded);
  }
  if (!decoded.ok || commandType !== "SteerWork") return decoded;
  return validateSteerWorkPayloadVersion(payload, schemaVersion, decoded);
};

export const decodeExternalCommand = (
  envelope: unknown,
): DecodeExternalCommandResult =>
  ExternalCommandDecoder.decodeEnvelope(envelope);

function decodeCommandPayloadForContract(
  commandType: RegisteredCommandType,
  payload: unknown,
  origin: "External" | "Internal" = "External",
): DecodeCommandPayloadResult {
  const decoded = decodeAgainstRule(payloadRules[commandType], payload);
  if (
    decoded.ok &&
    origin === "External" &&
    commandType === "AuthorizeWorkspaceSandbox" &&
    (decoded.value as AuthorizeWorkspaceSandboxPayload).source.kind !== "Human"
  ) {
    return { ok: false, issues: [{ path: ["source", "kind"], rule: "enum" }] };
  }
  if (decoded.ok && commandType === "GrantPermission") {
    return validateGrantPermissionLifetime(
      decoded.value as GrantPermissionPayload,
      decoded,
    );
  }
  if (!decoded.ok || commandType !== "SteerWork") return decoded;
  const input = payload as {
    readonly steer?: Record<string, unknown>;
  };
  const steer = input.steer;
  if (steer === undefined || typeof steer !== "object" || steer === null) {
    return {
      ok: false,
      issues: [{ path: ["steer"], rule: "format" }],
    };
  }
  const hasOperation = Object.hasOwn(steer, "operation");
  return validateSteerWorkPayloadVersion(
    payload,
    hasOperation ? "2" : "1",
    decoded,
  );
}

function validateGrantPermissionLifetime(
  payload: GrantPermissionPayload,
  decoded: DecodeCommandPayloadResult,
): DecodeCommandPayloadResult {
  return payload.expiresAt === null &&
    !isPersistentWorkspaceToolPermission(payload)
    ? { ok: false, issues: [{ path: ["expiresAt"], rule: "format" }] }
    : decoded;
}

function validateSteerWorkPayloadVersion(
  payload: unknown,
  schemaVersion: "1" | "2",
  decoded: DecodeCommandPayloadResult,
): DecodeCommandPayloadResult {
  const input = payload as {
    readonly steer?: Record<string, unknown>;
  };
  const steer = input.steer;
  if (steer === undefined || typeof steer !== "object" || steer === null) {
    return {
      ok: false,
      issues: [{ path: ["steer"], rule: "format" }],
    };
  }
  const hasOperation = Object.hasOwn(steer, "operation");
  const hasLegacyGuidance = Object.hasOwn(steer, "guidance");
  const hasLegacyScope = Object.hasOwn(steer, "scope");
  const validLegacy =
    !hasOperation && hasLegacyGuidance && typeof steer.guidance === "string";
  const validTyped = hasOperation && !hasLegacyGuidance && !hasLegacyScope;
  if (
    (schemaVersion === "1" && !validLegacy) ||
    (schemaVersion === "2" && !validTyped) ||
    (!validLegacy && !validTyped)
  ) {
    return {
      ok: false,
      issues: [
        {
          path: ["steer", schemaVersion === "1" ? "operation" : "guidance"],
          rule:
            (hasOperation && schemaVersion === "1") ||
            (!hasOperation && schemaVersion === "2")
              ? "unsupported-version"
              : "format",
        },
      ],
    };
  }
  return decoded;
}

const decodeEnvelopeWithRegistry = (
  registry: CommandInputContractRegistry,
  envelope: unknown,
): DecodeExternalCommandResult => {
  if (!isRecord(envelope)) {
    return { ok: false, issues: [{ path: [], rule: "type" }] };
  }
  const commandType = envelope.commandType;
  if (
    typeof commandType !== "string" ||
    registry.lookup(commandType) === undefined
  ) {
    return {
      ok: false,
      issues: [{ path: ["commandType"], rule: "unsupported-command" }],
    };
  }
  const envelopeRule = object({
    commandType: literal(commandType),
    commandId: id("CommandId"),
    projectId: id("ProjectId"),
    actor,
    issuedAt: string,
    payload: payloadRules[commandType as RegisteredCommandType],
  });
  const decoded = decodeAgainstRule(envelopeRule, envelope);
  if (!decoded.ok) return decoded;
  if (
    commandType === "SteerWork" ||
    commandType === "AuthorizeWorkspaceSandbox"
  ) {
    const validatedPayload = decodeCommandPayloadForContract(
      commandType,
      envelope.payload,
    );
    if (!validatedPayload.ok) return validatedPayload;
  }
  if (commandType === "DecideSandboxPolicy") {
    const decodedEnvelope = decoded.value as {
      readonly payload: Record<string, unknown>;
    };
    const payload = decodedEnvelope.payload;
    const selection = decodeSandboxNetworkPolicySelectionV1(
      payload.networkPolicy,
    );
    const hasRegistryRevision = Object.hasOwn(
      payload,
      "expectedProviderRegistryRevision",
    );
    const hasRegistryDigest = Object.hasOwn(
      payload,
      "expectedProviderRegistryDigest",
    );
    const hasProviderVersion = Object.hasOwn(payload, "providerVersion");
    const hasCapabilityRevision = Object.hasOwn(payload, "capabilityRevision");
    const providerSelectorShapeMatches =
      hasProviderVersion === hasCapabilityRevision;
    const variantMatches =
      selection?.kind === "OsEnforced"
        ? payload.profile !== "FullAccess" &&
          payload.providerId !== "TrustedLocal" &&
          hasRegistryRevision &&
          hasRegistryDigest &&
          providerSelectorShapeMatches
        : selection?.kind === "TrustedLocalUnconfinedV1" &&
          payload.profile === "FullAccess" &&
          payload.providerId === "TrustedLocal" &&
          !hasRegistryRevision &&
          !hasRegistryDigest &&
          !hasProviderVersion &&
          !hasCapabilityRevision;
    if (!variantMatches) {
      return {
        ok: false,
        issues: [{ path: ["payload"], rule: "format" }],
      };
    }
  }
  return { ok: true, value: decoded.value as DecodedExternalCommandEnvelope };
};
