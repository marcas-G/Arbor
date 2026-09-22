import {
  type ProjectId,
  regionsOverlap,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  GitWorktreeAddress,
  PendingDomainEvent,
  ProjectEnvironmentPortService,
  ResourceOwnershipRepositoryService,
  WorkspaceRepositoryService,
  WorktreeStoreService,
} from "@arbor/ports";
import { resourceRegionComparator } from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

/** P11 `09` §3: worktree creation is NOT itself an environment change —
 * only a change in the resolved region set is a RecordEnvironmentChange
 * (cause WorktreeLifecycle, following `03` CAS). This handler therefore
 * never calls REC; the follow-up change record is issued where the region
 * set actually moves. */
export interface CreateWorktreePayload {
  readonly worktreeId: string;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly address: GitWorktreeAddress;
}

export interface CreateWorktreeResult {
  readonly worktreeId: string;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly path: string;
  readonly state: "Active";
}

export interface CreateWorktreeDependencies {
  readonly worktrees: WorktreeStoreService;
  readonly workspaces: WorkspaceRepositoryService;
}

export const makeCreateWorktreeHandler = (
  dependencies: CreateWorktreeDependencies,
): CommandHandler<CreateWorktreePayload, CreateWorktreeResult> => ({
  commandType: "CreateWorktree",
  schemaVersion: "1",
  authority: {
    tag: "CreateWorktreeAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "CreateWorktreeAuthority" &&
      authority.targetWorkspaceId === payload.workspaceId &&
      authority.worktreeId === payload.worktreeId,
  },
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      if (payload.projectId !== envelope.projectId) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "worktree projectId does not match the command envelope",
        });
      }
      const existing = yield* dependencies.worktrees.findById(
        payload.worktreeId,
      );
      if (Option.isSome(existing)) {
        return commandErr({
          _tag: "WorktreeAlreadyExists",
          worktreeId: payload.worktreeId,
        });
      }
      const workspaceOption = yield* dependencies.workspaces.findById(
        payload.workspaceId,
      );
      if (Option.isNone(workspaceOption)) {
        return commandErr({
          _tag: "WorkspaceNotFound",
          workspaceId: payload.workspaceId,
        });
      }
      const workspace = workspaceOption.value;
      if (workspace.projectId !== envelope.projectId) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "workspace belongs to another project",
        });
      }
      if (workspace.lifecycle !== "Active") {
        return commandErr({
          _tag: "WorkspaceNotActive",
          workspaceId: payload.workspaceId,
          lifecycle: workspace.lifecycle,
        });
      }
      yield* dependencies.worktrees.insert({
        worktreeId: payload.worktreeId,
        projectId: envelope.projectId,
        workspaceId: payload.workspaceId,
        address: payload.address,
        state: "Active",
        createdAt: envelope.issuedAt,
      });

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "WorktreeCreated",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.worktreeId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          // The frozen event schema carries repositoryRef/branch as required
          // strings; the optional address payload normalizes to "" when
          // absent (the state row keeps them nullable).
          payload: {
            worktreeId: payload.worktreeId,
            projectId: envelope.projectId,
            workspaceId: payload.workspaceId,
            path: payload.address.path,
            repositoryRef: payload.address.repositoryRef ?? "",
            branch: payload.address.branch ?? "",
          },
        },
      ];

      return commandOk({
        result: {
          worktreeId: payload.worktreeId,
          projectId: envelope.projectId,
          workspaceId: payload.workspaceId,
          path: payload.address.path,
          state: "Active",
        },
        events,
      });
    }),
});

export interface RetireWorktreePayload {
  readonly worktreeId: string;
  readonly expectedState: "Active";
}

export interface RetireWorktreeResult {
  readonly worktreeId: string;
  readonly projectId: ProjectId;
  readonly fromState: "Active";
  readonly toState: "Retired";
  readonly retiredAt: string;
}

export interface RetireWorktreeDependencies {
  readonly worktrees: WorktreeStoreService;
  readonly environment: Pick<ProjectEnvironmentPortService, "resolve">;
  readonly ownership: Pick<
    ResourceOwnershipRepositoryService,
    "loadActiveConflicts"
  >;
}

export const makeRetireWorktreeHandler = (
  dependencies: RetireWorktreeDependencies,
): CommandHandler<RetireWorktreePayload, RetireWorktreeResult> => ({
  commandType: "RetireWorktree",
  schemaVersion: "1",
  authority: {
    tag: "RetireWorktreeAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "RetireWorktreeAuthority" &&
      authority.worktreeId === payload.worktreeId,
  },
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const existing = yield* dependencies.worktrees.findById(
        payload.worktreeId,
      );
      if (Option.isNone(existing)) {
        return commandErr({
          _tag: "WorktreeNotFound",
          worktreeId: payload.worktreeId,
        });
      }
      const worktree = existing.value;
      if (worktree.state !== payload.expectedState) {
        return commandErr({
          _tag: "WorktreeAlreadyRetired",
          worktreeId: payload.worktreeId,
        });
      }

      // P11 `09` §3 (CI-3): no active ownership claims may be resolved into
      // the worktree's regions — §1.4A release-first, enforced not bypassed.
      // The operator releases via the `10` paths before retiring.
      const resolved = yield* dependencies.environment.resolve(
        envelope.projectId,
        [worktree.address],
      );
      const activeClaims = (yield* Effect.forEach(resolved.regions, (region) =>
        dependencies.ownership.loadActiveConflicts(region.resourceSpaceId),
      )).flat();
      const blocking = activeClaims.filter((claim) =>
        resolved.regions.some((region) =>
          regionsOverlap(claim.region, region, resourceRegionComparator),
        ),
      );
      if (blocking.length > 0) {
        return commandErr({
          _tag: "ActiveClaimsExist",
          worktreeId: payload.worktreeId,
          claimIds: blocking.map((claim) => claim.claimId),
        });
      }

      const retired = yield* dependencies.worktrees.retireIfActive(
        payload.worktreeId,
        envelope.issuedAt,
      );
      if (Option.isNone(retired)) {
        return commandErr({
          _tag: "WorktreeAlreadyRetired",
          worktreeId: payload.worktreeId,
        });
      }

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "WorktreeRetired",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.worktreeId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            worktreeId: payload.worktreeId,
            projectId: envelope.projectId,
          },
        },
      ];

      return commandOk({
        result: {
          worktreeId: payload.worktreeId,
          projectId: envelope.projectId,
          fromState: "Active",
          toState: "Retired",
          retiredAt: envelope.issuedAt,
        },
        events,
      });
    }),
});
