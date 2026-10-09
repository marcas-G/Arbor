import type { Workspace, WorkspaceId } from "@arbor/domain";
import {
  AcceptanceRepository,
  FormationFulfillmentStore,
  FormationProposalStore,
  sha256Hex,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
  WorkspacePlacementPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

const PAGE_SIZE = 20;

const childRef = (rootWorkspaceId: WorkspaceId, child: Workspace): string =>
  `wref_${sha256Hex(
    JSON.stringify({
      rootWorkspaceId,
      childWorkspaceId: child.workspaceId,
      revision: child.revision,
    }),
  )}`;

const proposalRef = (proposalId: string, revision: number): string =>
  `pref_${sha256Hex(JSON.stringify({ proposalId, revision }))}`;

const resultRef = (input: {
  readonly parentWorkspaceId: WorkspaceId;
  readonly childWorkspaceId: WorkspaceId;
  readonly workId: string;
  readonly workRevision: number;
  readonly verificationId: string;
}): string => `rref_${sha256Hex(JSON.stringify(input))}`;

const parseCursor = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  const match = /^pc_(\d+)$/u.exec(cursor);
  return match === null ? 0 : Number(match[1]);
};

const responsibilitySummary = (workspace: Workspace): string =>
  workspace.responsibilityDefinition.purpose;

/** MAC-P2: canonical direct-child and in-flight formation placement view. */
export const WorkspacePlacementPortLive: Layer.Layer<
  WorkspacePlacementPort,
  never,
  | FormationProposalStore
  | FormationFulfillmentStore
  | AcceptanceRepository
  | TransactionPort
  | VerificationRepository
  | WorkRepository
  | WorkspaceRepository
> = Layer.effect(
  WorkspacePlacementPort,
  Effect.gen(function* () {
    const proposals = yield* FormationProposalStore;
    const fulfillments = yield* FormationFulfillmentStore;
    const acceptances = yield* AcceptanceRepository;
    const tx = yield* TransactionPort;
    const verifications = yield* VerificationRepository;
    const works = yield* WorkRepository;
    const workspaces = yield* WorkspaceRepository;

    const list = (input: {
      readonly rootWorkspaceId: WorkspaceId;
      readonly cursor?: string;
      readonly query?: string;
    }) =>
      tx.transact(
        Effect.gen(function* () {
          const root = yield* workspaces.findById(input.rootWorkspaceId);
          if (Option.isNone(root)) {
            return {
              current: {
                ref: "current" as const,
                name: "Unavailable",
                responsibilitySummary: "",
                currentWorkSummary: null,
                openWorkCount: 0,
                readyResults: [],
                revision: 0,
              },
              directChildren: [],
              inFlightFormations: [],
              nextCursor: null,
              fingerprint: `wpf_${sha256Hex("missing")}`,
            };
          }
          const allChildren = yield* workspaces.listActiveChildren(
            input.rootWorkspaceId,
          );
          const query = input.query?.trim().toLowerCase();
          const filtered =
            query === undefined || query.length === 0
              ? allChildren
              : allChildren.filter((child) =>
                  `${child.name} ${JSON.stringify(child.responsibilityDefinition)}`
                    .toLowerCase()
                    .includes(query),
                );
          const offset = parseCursor(input.cursor);
          const page = filtered.slice(offset, offset + PAGE_SIZE);
          const summarize = (workspace: Workspace) =>
            Effect.gen(function* () {
              const open = yield* works.listByWorkspace(
                workspace.workspaceId,
                "Open",
              );
              const current = open.find(
                (work) => work.workId === workspace.currentWorkId,
              );
              const readyResults: Array<{
                resultRef: string;
                objective: string;
                workRevision: import("@arbor/domain").WorkRevision;
              }> = [];
              if (workspace.workspaceId !== input.rootWorkspaceId) {
                for (const work of open) {
                  const history = yield* verifications.listByWork(work.workId);
                  const pass = history.find(
                    (verification) =>
                      verification.targetWorkRevision === work.revision &&
                      verification.state.status === "Concluded" &&
                      verification.state.verdict === "Pass",
                  );
                  if (pass === undefined) continue;
                  const accepted = yield* acceptances.findByWorkRevision(
                    work.workId,
                    work.revision,
                  );
                  if (Option.isSome(accepted)) continue;
                  readyResults.push({
                    resultRef: resultRef({
                      parentWorkspaceId: input.rootWorkspaceId,
                      childWorkspaceId: workspace.workspaceId,
                      workId: work.workId,
                      workRevision: Number(work.revision),
                      verificationId: pass.verificationId,
                    }),
                    objective: work.objective,
                    workRevision: work.revision,
                  });
                }
              }
              return {
                ref:
                  workspace.workspaceId === input.rootWorkspaceId
                    ? ("current" as const)
                    : childRef(input.rootWorkspaceId, workspace),
                name: workspace.name,
                responsibilitySummary: responsibilitySummary(workspace),
                currentWorkSummary: current?.objective ?? null,
                openWorkCount: open.length,
                readyResults,
                revision: Number(workspace.revision),
              };
            });
          const current = yield* summarize(root.value);
          const directChildren = yield* Effect.forEach(page, summarize, {
            concurrency: 1,
          });
          const formationRows = yield* proposals.listByParent(
            input.rootWorkspaceId,
          );
          const inFlightRows = formationRows.filter(
            (proposal) =>
              proposal.state === "Pending" || proposal.state === "Approved",
          );
          const inFlightFormations = yield* Effect.forEach(
            inFlightRows,
            (proposal) =>
              Effect.gen(function* () {
                const fulfillment = yield* fulfillments.findByProposal(
                  proposal.proposalId,
                  proposal.revision,
                );
                return {
                  proposalRef: proposalRef(
                    String(proposal.proposalId),
                    proposal.revision,
                  ),
                  proposedName: proposal.proposal.name,
                  responsibilitySummary:
                    proposal.proposal.responsibilityDraft.purpose,
                  initialWorkSummary:
                    proposal.proposal.initialWork?.objective ?? null,
                  governanceState: proposal.state as "Pending" | "Approved",
                  fulfillmentState: Option.isSome(fulfillment)
                    ? fulfillment.value.state
                    : proposal.state === "Approved"
                      ? ("PendingApplication" as const)
                      : ("AwaitingDecision" as const),
                  revision: proposal.revision,
                };
              }),
            { concurrency: 1 },
          );
          const nextOffset = offset + page.length;
          const snapshot = {
            current: { ...current, ref: "current" as const },
            directChildren,
            inFlightFormations,
            nextCursor:
              nextOffset < filtered.length ? `pc_${nextOffset}` : null,
          };
          return {
            ...snapshot,
            fingerprint: `wpf_${sha256Hex(JSON.stringify(snapshot))}`,
          };
        }),
      );

    return WorkspacePlacementPort.of({
      list,
      resolveChildRef: (rootWorkspaceId, ref) =>
        tx.transact(
          Effect.gen(function* () {
            const children =
              yield* workspaces.listActiveChildren(rootWorkspaceId);
            const match = children.find(
              (child) => childRef(rootWorkspaceId, child) === ref,
            );
            return match === undefined
              ? Option.none()
              : Option.some({
                  _tag: "ResolvedChildPlacementRef" as const,
                  projectId: match.projectId,
                  targetWorkspaceId: match.workspaceId,
                  targetWorkspaceRevision: Number(match.revision),
                  refEncodingVersion: 1 as const,
                });
          }),
        ),
      read: (rootWorkspaceId, ref) =>
        tx.transact(
          Effect.gen(function* () {
            const root = yield* workspaces.findById(rootWorkspaceId);
            if (Option.isNone(root)) return Option.none();
            const target =
              ref === "current"
                ? root.value
                : (yield* workspaces.listActiveChildren(rootWorkspaceId)).find(
                    (child) => childRef(rootWorkspaceId, child) === ref,
                  );
            if (target === undefined) return Option.none();
            const open = yield* works.listByWorkspace(
              target.workspaceId,
              "Open",
            );
            const current = open.find(
              (work) => work.workId === target.currentWorkId,
            );
            return Option.some({
              ref:
                target.workspaceId === rootWorkspaceId
                  ? "current"
                  : childRef(rootWorkspaceId, target),
              name: target.name,
              responsibilitySummary: responsibilitySummary(target),
              currentWorkSummary: current?.objective ?? null,
              openWorkCount: open.length,
              readyResults: [],
              revision: Number(target.revision),
            });
          }),
        ),
      resolveResultRef: (parentWorkspaceId, ref) =>
        tx.transact(
          Effect.gen(function* () {
            const children =
              yield* workspaces.listActiveChildren(parentWorkspaceId);
            for (const child of children) {
              const open = yield* works.listByWorkspace(
                child.workspaceId,
                "Open",
              );
              for (const work of open) {
                const history = yield* verifications.listByWork(work.workId);
                const pass = history.find(
                  (verification) =>
                    verification.targetWorkRevision === work.revision &&
                    verification.state.status === "Concluded" &&
                    verification.state.verdict === "Pass",
                );
                if (pass === undefined) continue;
                const accepted = yield* acceptances.findByWorkRevision(
                  work.workId,
                  work.revision,
                );
                if (Option.isSome(accepted)) continue;
                const expectedRef = resultRef({
                  parentWorkspaceId,
                  childWorkspaceId: child.workspaceId,
                  workId: work.workId,
                  workRevision: Number(work.revision),
                  verificationId: pass.verificationId,
                });
                if (expectedRef === ref) {
                  return Option.some({
                    childWorkspaceId: child.workspaceId,
                    workId: work.workId,
                    workRevision: work.revision,
                    verificationId: pass.verificationId,
                  });
                }
              }
            }
            return Option.none();
          }),
        ),
    });
  }),
);
