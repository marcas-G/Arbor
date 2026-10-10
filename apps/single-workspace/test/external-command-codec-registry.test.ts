import { readFileSync } from "node:fs";
import {
  CommandHandlerRegistry,
  CommandInputContractRegistry,
  makeAcceptWorkOutcomeHandler,
  makeCancelConversationResponseHandler,
  makeCommandInputContractRegistry,
  makeCompleteWorkHandler,
  makeConcludeVerificationHandler,
  makeDeclareDependencyHandler,
  makeGrantPermissionHandler,
  makeP1CommandHandlers,
  makeP15CommandHandlers,
  makeProduceDeliverableHandler,
  makeRecordDecisionHandler,
  makeRecordVerificationEvidenceHandler,
  makeResolveControlApprovalHandler,
  makeResumeConversationResponseHandler,
  makeRevokePermissionHandler,
  makeSatisfyDependencyHandler,
  makeSelectCurrentWorkHandler,
  makeSendMessageHandler,
  makeStartVerificationHandler,
  makeSteerWorkHandler,
  makeSubmitHumanMessageHandler,
} from "@arbor/application";
import { makeP2CommandHandlers } from "@arbor/execution-runtime";
import {
  AcceptanceRepository,
  ControlApprovalStore,
  ConversationResponseJobStore,
  DeliverableRepository,
  DependencyRepository,
  EnvironmentRevisionStore,
  EvidenceRepository,
  ExecutionRepository,
  FormationProposalStore,
  HumanMessageStore,
  InboxProjectionStore,
  MessageStore,
  PermissionGrantRepository,
  ProjectRepository,
  ProjectResourceProfilePort,
  SessionRepository,
  VerificationRepository,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { makeProjectResourceProfilePort } from "../src/project-resource-profiles.js";
import { SingleWorkspaceCommandHandlerRegistryLive } from "../src/registry.js";

describe("external command codec registry parity", () => {
  it("has exactly one descriptor for every composed production handler", () => {
    const unused = {} as never;
    const productionSource = readFileSync(
      "apps/single-workspace/src/registry.ts",
      "utf8",
    );
    const arrayStart = productionSource.indexOf("const handlers:");
    const arrayEnd = productionSource.indexOf("];", arrayStart);
    if (arrayStart < 0 || arrayEnd < 0) {
      throw new Error("could not locate production command handler array");
    }
    const productionArray = productionSource.slice(arrayStart, arrayEnd);
    const directFactories = [
      ...productionArray.matchAll(/\b(make[A-Z]\w+Handler)\s*\(/g),
    ].map((match) => match[1] ?? "");
    const factories = {
      makeAcceptWorkOutcomeHandler,
      makeCancelConversationResponseHandler,
      makeCompleteWorkHandler,
      makeConcludeVerificationHandler,
      makeDeclareDependencyHandler,
      makeGrantPermissionHandler,
      makeProduceDeliverableHandler,
      makeRecordDecisionHandler,
      makeRecordVerificationEvidenceHandler,
      makeResolveControlApprovalHandler,
      makeResumeConversationResponseHandler,
      makeRevokePermissionHandler,
      makeSatisfyDependencyHandler,
      makeSelectCurrentWorkHandler,
      makeSendMessageHandler,
      makeStartVerificationHandler,
      makeSteerWorkHandler,
      makeSubmitHumanMessageHandler,
    } as const;
    const productionHandlerTypes = directFactories.map((name) => {
      const factory = factories[name as keyof typeof factories];
      if (factory === undefined) {
        throw new Error(`unhandled production command factory: ${name}`);
      }
      return factory(unused).commandType;
    });
    if (productionArray.includes("...makeP1CommandHandlers(")) {
      productionHandlerTypes.push(
        ...makeP1CommandHandlers(unused).map((handler) => handler.commandType),
      );
    }
    if (productionArray.includes("...makeP15CommandHandlers(")) {
      productionHandlerTypes.push(
        ...makeP15CommandHandlers(unused).map((handler) => handler.commandType),
      );
    }
    if (productionArray.includes("...makeP2CommandHandlers(")) {
      productionHandlerTypes.push(
        ...makeP2CommandHandlers(unused).map((handler) => handler.commandType),
      );
    }

    const registry = makeCommandInputContractRegistry(productionHandlerTypes);
    expect(registry.commandTypes).toHaveLength(26);
    expect(new Set(registry.commandTypes).size).toBe(26);
    expect(registry.commandTypes.toSorted()).toEqual(
      productionHandlerTypes.toSorted(),
    );
    expect(registry.lookup("ReviseDependencyContract")).toBeUndefined();
    expect(registry.lookup("CreateWorktree")).toBeUndefined();
  });

  it("fails closed when the handler set has a missing, duplicate, or extra command", () => {
    const current = makeCommandInputContractRegistry().commandTypes;
    const first = current[0] ?? "CreateProject";
    expect(() => makeCommandInputContractRegistry(current.slice(1))).toThrow();
    expect(() =>
      makeCommandInputContractRegistry([...current, first]),
    ).toThrow();
    expect(() =>
      makeCommandInputContractRegistry([...current, "FactoryOnly"]),
    ).toThrow();
  });

  it("matches the actual production composition with ControlApprovalStore present or absent", () => {
    const actualTypes = (includeControlApprovalStore: boolean) => {
      const baseServices = [
        Layer.succeed(ProjectRepository, {} as never),
        Layer.succeed(
          ProjectResourceProfilePort,
          makeProjectResourceProfilePort([]),
        ),
        Layer.succeed(WorkspaceRepository, {} as never),
        Layer.succeed(SessionRepository, {} as never),
        Layer.succeed(WorkRepository, {} as never),
        Layer.succeed(ExecutionRepository, {} as never),
        Layer.succeed(WorkWaitStore, {} as never),
        Layer.succeed(FormationProposalStore, {} as never),
        Layer.succeed(InboxProjectionStore, {} as never),
        Layer.succeed(MessageStore, {} as never),
        Layer.succeed(VerificationRepository, {} as never),
        Layer.succeed(AcceptanceRepository, {} as never),
        Layer.succeed(PermissionGrantRepository, {} as never),
        Layer.succeed(HumanMessageStore, {} as never),
        Layer.succeed(ConversationResponseJobStore, {} as never),
        Layer.succeed(DependencyRepository, {} as never),
        Layer.succeed(DeliverableRepository, {} as never),
        Layer.succeed(EnvironmentRevisionStore, {} as never),
        Layer.succeed(EvidenceRepository, {} as never),
        Layer.succeed(SqlClient, {} as never),
      ] as const;
      const services = includeControlApprovalStore
        ? Layer.mergeAll(
            ...baseServices,
            Layer.succeed(ControlApprovalStore, {} as never),
          )
        : Layer.mergeAll(...baseServices);
      const registryLayer = Layer.provide(
        SingleWorkspaceCommandHandlerRegistryLive,
        services,
      );
      const registry = Effect.runSync(
        Effect.provide(
          Effect.gen(function* () {
            return yield* CommandHandlerRegistry;
          }),
          registryLayer,
        ),
      );
      return CommandInputContractRegistry.commandTypes.filter((type) =>
        Option.isSome(registry.lookup(type)),
      );
    };

    const withApproval = actualTypes(true);
    const withoutApproval = actualTypes(false);
    const fullRegistry = makeCommandInputContractRegistry(withApproval);
    const reducedRegistry = makeCommandInputContractRegistry(withoutApproval);

    expect(withApproval).toHaveLength(26);
    expect(fullRegistry.commandTypes).toHaveLength(26);
    expect(withoutApproval).toHaveLength(25);
    expect(reducedRegistry.commandTypes).toHaveLength(25);
    expect(reducedRegistry.lookup("ResolveControlApproval")).toBeUndefined();
    expect(withApproval.toSorted()).toEqual(
      CommandInputContractRegistry.commandTypes.toSorted(),
    );
    expect(withoutApproval.toSorted()).toEqual(
      CommandInputContractRegistry.commandTypes
        .filter((type) => type !== "ResolveControlApproval")
        .toSorted(),
    );
    for (const factoryOnly of [
      "ReviseDependencyContract",
      "WithdrawDependency",
      "MarkDependencyUnfulfillable",
      "RegisterProjectTool",
      "CreateWorktree",
      "RetireWorktree",
    ]) {
      expect(fullRegistry.lookup(factoryOnly)).toBeUndefined();
      expect(reducedRegistry.lookup(factoryOnly)).toBeUndefined();
    }
  });

  it("keeps codec acceptance separate from external-origin policy", () => {
    const registry = makeCommandInputContractRegistry();
    expect(registry.lookup("AssignWork")?.externalOriginAllowed).toBe(false);
    expect(registry.lookup("AssignWork")?.externalOriginPolicy).toBe(
      "reject external; agent-originated",
    );
    expect(registry.lookup("CreateProject")?.externalOriginAllowed).toBe(true);
    expect(registry.lookup("SubmitHumanMessage")?.externalOriginAllowed).toBe(
      true,
    );
    expect(registry.lookup("AdmitExecution")?.externalOriginAllowed).toBe(
      false,
    );
  });

  it("accepts only the v2 Profile/ConversationOnly resource selector for CreateProject", () => {
    const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789ab";
    const sessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789ab";
    const base = {
      name: "Project",
      revision: 0,
      projectPolicy: { delegationCeiling: 1 },
      projectPolicyRevision: 0,
      defaultConfiguration: {},
      environmentRef: "local",
      rootWorkspaceId: workspaceId,
      primarySession: { sessionId, contextEpoch: 0 },
      rootWorkspace: {
        name: "root",
        responsibilityDefinition: {
          purpose: "Project",
          ownedResponsibilities: [],
          obligations: [],
          includes: [],
          excludes: [],
          interfaces: [],
        },
        responsibilityRevision: 0,
        agentBinding: {
          _tag: "ResponsibilityBoundAgentBinding",
          workspaceId,
        },
        workspacePolicy: { delegationCeiling: 1 },
        workspacePolicyRevision: 0,
        revision: 0,
      },
    };
    const contract = CommandInputContractRegistry.lookup("CreateProject");
    expect(contract).toBeDefined();
    const profileSelection = contract?.decodePayload({
      ...base,
      rootWorkspace: {
        ...base.rootWorkspace,
        resourceSelection: {
          _tag: "Profile",
          resourceProfileRef: "project-root",
          version: "v-test",
        },
      },
    });
    expect(profileSelection?.ok).toBe(true);
    expect(
      contract?.decodePayload({
        ...base,
        rootWorkspace: {
          ...base.rootWorkspace,
          resourceSelection: { _tag: "ConversationOnly" },
        },
      }).ok,
    ).toBe(true);
    const legacy = contract?.decodePayload({
      ...base,
      rootWorkspace: {
        ...base.rootWorkspace,
        resourceBoundary: { basisResponsibilityRevision: 0, addresses: [] },
        resourceBoundaryRevision: 0,
      },
    });
    expect(legacy?.ok).toBe(false);
    const mixed = contract?.decodePayload({
      ...base,
      rootWorkspace: {
        ...base.rootWorkspace,
        resourceSelection: { _tag: "ConversationOnly" },
        resourceBoundary: { basisResponsibilityRevision: 0, addresses: [] },
        resourceBoundaryRevision: 0,
      },
    });
    expect(mixed?.ok).toBe(false);
  });
});
