/**
 * P14 `04` §1/§2 — conversation tab. The read-only transcript is shared by
 * root and child workspaces; the composer is the single input face and is
 * rendered ONLY on the Root Workspace (the Tree node with a null server
 * parent). The root decision is data-driven here, not route-driven.
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
import { presentResponsibilityTree } from "../tree/treePresentation.js";
import styles from "./workspace.module.css";

type WorkspaceId = ViewRequestMap["transcript"]["workspaceId"];
type ProjectId = ViewRequestMap["responsibility-tree"]["projectId"];

const TRANSCRIPT_PAGE_SIZE = 20;

const asProblem = (error: unknown): Problem => error as Problem;

const PENDING_TURN_KINDS = {
  human: "HumanConversationTurn",
  assistant: "AssistantConversationTurn",
} as const;

/** A last Human turn without a later Assistant turn is the only observable
 * pending fact the view can state; it is not a client execution lifecycle. */
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
  return lastHuman !== -1 && lastAssistant < lastHuman
    ? "已入列，等待服务器结果"
    : null;
};

export function ConversationRecord({
  projectId,
  workspaceId,
  rootWorkspaceId,
}: {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly rootWorkspaceId?: string | undefined;
}) {
  const session = useSession();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const request: TranscriptReq =
    cursor === undefined
      ? { workspaceId: workspaceId as WorkspaceId, limit: TRANSCRIPT_PAGE_SIZE }
      : {
          workspaceId: workspaceId as WorkspaceId,
          cursor,
          limit: TRANSCRIPT_PAGE_SIZE,
        };
  const transcript = useViewQuery("transcript", request);
  const isRoot = rootWorkspaceId === workspaceId;
  const queuedState =
    transcript.data === undefined
      ? null
      : deriveQueuedState(transcript.data.entries);
  return (
    <div className={styles.conversation}>
      <p className={styles.conversationLabel}>
        {isRoot ? "根工作区对话" : "对话记录（只读）"}
      </p>
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

export function ConversationTab({
  projectId,
  workspaceId,
}: {
  readonly projectId: string;
  readonly workspaceId: string;
}) {
  const tree = useViewQuery("responsibility-tree", {
    projectId: projectId as ProjectId,
  });
  const presented =
    tree.data === undefined
      ? undefined
      : presentResponsibilityTree(tree.data.nodes);
  return (
    <ConversationRecord
      projectId={projectId}
      workspaceId={workspaceId}
      rootWorkspaceId={presented?.root.workspaceId}
    />
  );
}
