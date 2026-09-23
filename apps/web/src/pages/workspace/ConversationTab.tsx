/**
 * P14 `04` §1/§2 — conversation tab. The read-only transcript is shared by
 * root and child workspaces; the composer is the single input face and is
 * rendered ONLY on the Root Workspace (tree nodes[0], the Web v1 root
 * authority). The root decision is data-driven here, not route-driven.
 */
import type {
  Problem,
  TranscriptReq,
  ViewRequestMap,
} from "@arbor/api-contracts";
import { useState } from "react";
import { useViewQuery } from "../../api/useViewQuery.js";
import { SubmitHumanMessageForm } from "../../commands/forms/SubmitHumanMessageForm.js";
import { Empty } from "../../components/Empty.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import { useSession } from "../../session/SessionContext.js";
import { TranscriptView } from "../../views/TranscriptView.js";
import styles from "./workspace.module.css";

type WorkspaceId = ViewRequestMap["transcript"]["workspaceId"];
type ProjectId = ViewRequestMap["responsibility-tree"]["projectId"];

const TRANSCRIPT_PAGE_SIZE = 20;

const asProblem = (error: unknown): Problem => error as Problem;

const PENDING_TURN_KINDS = {
  human: "HumanConversationTurn",
  assistant: "AssistantConversationTurn",
} as const;

/** Derived read-only "queued/running" line: a Human turn with no later
 * Assistant turn is durable-pending (`02` one-active-main). `null` when the
 * current DTO cannot decide (no human turns). */
const deriveQueuedState = (
  entries: ReadonlyArray<{ readonly kind: string }>,
): string | null => {
  let lastHuman = -1;
  let lastAssistant = -1;
  entries.forEach((entry, index) => {
    if (entry.kind === PENDING_TURN_KINDS.human) {
      lastHuman = index;
    }
    if (entry.kind === PENDING_TURN_KINDS.assistant) {
      lastAssistant = index;
    }
  });
  return lastHuman !== -1 && lastAssistant < lastHuman ? "排队中/执行中" : null;
};

export function ConversationTab({
  projectId,
  workspaceId,
}: {
  readonly projectId: string;
  readonly workspaceId: string;
}) {
  const session = useSession();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const tree = useViewQuery("responsibility-tree", {
    projectId: projectId as ProjectId,
  });
  const request: TranscriptReq =
    cursor === undefined
      ? { workspaceId: workspaceId as WorkspaceId, limit: TRANSCRIPT_PAGE_SIZE }
      : {
          workspaceId: workspaceId as WorkspaceId,
          cursor,
          limit: TRANSCRIPT_PAGE_SIZE,
        };
  const transcript = useViewQuery("transcript", request);
  const rootWorkspaceId =
    tree.data === undefined ? undefined : tree.data.nodes[0]?.workspaceId;
  const isRoot =
    rootWorkspaceId !== undefined && rootWorkspaceId === workspaceId;
  const queuedState =
    transcript.data === undefined
      ? null
      : deriveQueuedState(transcript.data.entries);
  return (
    <div className={styles.conversation}>
      {transcript.isPending ? (
        <Empty>加载中</Empty>
      ) : transcript.isError ? (
        <ProblemCard problem={asProblem(transcript.error)} />
      ) : (
        <TranscriptView
          res={transcript.data}
          onLoadMore={(nextCursor) => {
            setCursor(nextCursor);
          }}
        />
      )}
      {isRoot ? (
        <div className={styles.composer}>
          {queuedState === null ? null : (
            <p className={styles.composerStatus}>{queuedState}</p>
          )}
          <SubmitHumanMessageForm
            actor={session.actor ?? ""}
            token={session.token ?? undefined}
            projectId={projectId}
            targetWorkspaceId={workspaceId}
          />
        </div>
      ) : null}
    </div>
  );
}
