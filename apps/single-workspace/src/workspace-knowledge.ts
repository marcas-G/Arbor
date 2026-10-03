import {
  AcceptanceRepository,
  sha256Hex,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
  WorkspaceKnowledgePort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

const MAX_ACCEPTED_OUTCOMES = 20;

/** MAC-D5: deterministic accepted-source-only Workspace knowledge. */
export const WorkspaceKnowledgePortLive: Layer.Layer<
  WorkspaceKnowledgePort,
  never,
  | AcceptanceRepository
  | TransactionPort
  | VerificationRepository
  | WorkRepository
> = Layer.effect(
  WorkspaceKnowledgePort,
  Effect.gen(function* () {
    const acceptances = yield* AcceptanceRepository;
    const tx = yield* TransactionPort;
    const verifications = yield* VerificationRepository;
    const works = yield* WorkRepository;
    return WorkspaceKnowledgePort.of({
      load: (workspaceId) =>
        tx.transact(
          Effect.gen(function* () {
            const completed = yield* works.listByWorkspace(
              workspaceId,
              "Completed",
            );
            const entries: Array<
              import("@arbor/ports").AcceptedWorkKnowledgeEntry
            > = [];
            for (const work of [...completed]
              .sort((left, right) =>
                String(left.workId).localeCompare(String(right.workId)),
              )
              .slice(-MAX_ACCEPTED_OUTCOMES)) {
              const acceptance = yield* acceptances.findByWorkRevision(
                work.workId,
                work.revision,
              );
              if (Option.isNone(acceptance)) continue;
              const history = yield* verifications.listByWork(work.workId);
              const verification = history.find(
                (candidate) =>
                  candidate.verificationId ===
                    acceptance.value.verificationId &&
                  candidate.targetWorkRevision === work.revision &&
                  candidate.state.status === "Concluded" &&
                  candidate.state.verdict === "Pass",
              );
              if (verification === undefined) continue;
              entries.push({
                _tag: "AcceptedWorkOutcome",
                workId: work.workId,
                workRevision: work.revision,
                objective: work.objective,
                completionExpectation: work.completionExpectation,
                acceptanceId: acceptance.value.acceptanceId,
                verificationId: verification.verificationId,
                verificationSummaryRef: verification.summaryRef,
                artifactRefs: verification.targetArtifactVersions,
                acceptedAt: acceptance.value.acceptedAt,
                provenance: "CanonicalAcceptance",
              });
            }
            return {
              workspaceId,
              entries,
              fingerprint: `wkv_${sha256Hex(JSON.stringify(entries))}`,
            };
          }),
        ),
    });
  }),
);
