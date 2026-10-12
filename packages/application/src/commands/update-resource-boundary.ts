import {
  type ResourceBoundaryRevision,
  type Revision,
  updateResourceBoundary,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  ResourceOwnershipRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import { semanticRequestFingerprint } from "../fingerprint.js";
import type { CommandGatewayService, CommandHandler } from "../gateway.js";

/**
 * Application implementation of the frozen UpdateResourceBoundary command.
 * The local-admin adapter that invokes this command only constructs
 * shrink-to-empty requests, so it never introduces a caller-supplied host
 * path into the public command surface.
 */
export interface UpdateResourceBoundaryPayload {
  readonly workspaceId: WorkspaceId;
  readonly expectedWorkspaceRevision: Revision;
}

export interface UpdateResourceBoundaryResult {
  readonly workspaceId: WorkspaceId;
  readonly revision: Revision;
  readonly resourceBoundaryRevision: ResourceBoundaryRevision;
  readonly releasedClaimIds: ReadonlyArray<string>;
}

export interface UpdateResourceBoundaryDependencies {
  readonly workspaces: WorkspaceRepositoryService;
  readonly ownership: Pick<
    ResourceOwnershipRepositoryService,
    "listActiveByWorkspace" | "releaseClaim"
  >;
}

export const makeUpdateResourceBoundaryHandler = (
  dependencies: UpdateResourceBoundaryDependencies,
): CommandHandler<
  UpdateResourceBoundaryPayload,
  UpdateResourceBoundaryResult
> => ({
  commandType: "UpdateResourceBoundary",
  schemaVersion: "1",
  authority: {
    tag: "UpdateResourceBoundaryAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "UpdateResourceBoundaryAuthority" &&
      authority.targetWorkspaceId === payload.workspaceId,
  },
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const found = yield* dependencies.workspaces.findById(
        payload.workspaceId,
      );
      if (Option.isNone(found)) {
        return commandErr({
          _tag: "WorkspaceNotFound",
          workspaceId: payload.workspaceId,
        });
      }
      const workspace = found.value;
      if (workspace.projectId !== envelope.projectId) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "workspace belongs to another project",
        });
      }

      const resourceBoundary = {
        basisResponsibilityRevision: workspace.responsibilityRevision,
        addresses: [],
      };
      const transitioned = updateResourceBoundary(workspace, {
        authorized: true,
        expectedRevision: payload.expectedWorkspaceRevision,
        resourceBoundary,
        ownershipOverlapDetected: false,
      });
      if (!transitioned.ok) return commandErr(transitioned.error);

      // The lookup is scoped to the target Workspace. Preserve claim rows
      // whose source address remains in the new boundary; release only claims
      // corresponding to addresses removed by this command.
      const activeClaims = yield* dependencies.ownership.listActiveByWorkspace(
        payload.workspaceId,
      );
      const removedClaims = activeClaims.filter(
        (claim) =>
          !resourceBoundary.addresses.some(
            (address) => address === claim.sourceAddressSnapshot,
          ),
      );
      yield* Effect.forEach(removedClaims, (claim) =>
        dependencies.ownership.releaseClaim(claim.claimId, envelope.issuedAt),
      );
      yield* dependencies.workspaces.updateResourceBoundaryIfRevision(
        payload.workspaceId,
        payload.expectedWorkspaceRevision,
        transitioned.value.resourceBoundary,
        transitioned.value.resourceBoundaryRevision,
        transitioned.value.revision,
      );

      return commandOk({
        result: {
          workspaceId: payload.workspaceId,
          revision: transitioned.value.revision,
          resourceBoundaryRevision: transitioned.value.resourceBoundaryRevision,
          releasedClaimIds: removedClaims.map((claim) => claim.claimId),
        },
        events: [
          {
            projectId: envelope.projectId,
            eventType: "ResourceBoundaryChanged",
            eventVersion: 1,
            occurredAt: envelope.issuedAt,
            aggregateRef: payload.workspaceId,
            actor: envelope.actor,
            causedByCommandId: envelope.commandId,
            payload: {
              workspaceId: payload.workspaceId,
              resourceBoundary: transitioned.value.resourceBoundary,
              resourceBoundaryRevision:
                transitioned.value.resourceBoundaryRevision,
              revision: transitioned.value.revision,
            },
          },
          {
            projectId: envelope.projectId,
            eventType: "ResourceOwnershipChanged",
            eventVersion: 1,
            occurredAt: envelope.issuedAt,
            aggregateRef: payload.workspaceId,
            actor: envelope.actor,
            causedByCommandId: envelope.commandId,
            payload: {
              workspaceId: payload.workspaceId,
              releasedClaimIds: removedClaims.map((claim) => claim.claimId),
              resourceBoundaryRevision:
                transitioned.value.resourceBoundaryRevision,
            },
          },
        ],
      });
    }),
});

/** Trusted in-process admin invocation; no external command decoder/route is
 * registered for this operation. The authority fact is built here from the
 * same frozen Gateway fingerprint inputs used by `CommandGateway.execute`. */
export const executeShrinkWorkspaceResourceBoundary = (input: {
  readonly gateway: CommandGatewayService;
  readonly commandId: import("@arbor/domain").CommandId;
  readonly projectId: import("@arbor/domain").ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly expectedWorkspaceRevision: Revision;
  readonly actor: import("@arbor/domain").Actor;
  readonly principal: import("@arbor/domain").Principal;
  readonly issuedAt: string;
}) => {
  const payload: UpdateResourceBoundaryPayload = {
    workspaceId: input.workspaceId,
    expectedWorkspaceRevision: input.expectedWorkspaceRevision,
  };
  const fingerprint = semanticRequestFingerprint({
    commandType: "UpdateResourceBoundary",
    projectId: input.projectId,
    actor: input.actor,
    schemaVersion: "1",
    payload,
  });
  return input.gateway.execute<
    UpdateResourceBoundaryPayload,
    UpdateResourceBoundaryResult
  >(
    {
      commandType: "UpdateResourceBoundary",
      commandId: input.commandId,
      projectId: input.projectId,
      actor: input.actor,
      issuedAt: input.issuedAt,
      payload,
    },
    {
      _tag: "System",
      principal: input.principal,
      causationRef: "trusted-local-resource-boundary-admin",
    },
    {
      _tag: "UpdateResourceBoundaryAuthority",
      principal: input.principal,
      commandId: input.commandId,
      semanticRequestFingerprint: fingerprint,
      projectId: input.projectId,
      targetWorkspaceId: input.workspaceId,
    },
  );
};
