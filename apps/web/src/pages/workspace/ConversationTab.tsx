/**
 * P14 `04` §1/§2 — conversation tab. The read-only transcript is shared by
 * root and child workspaces; the composer is the single input face and is
 * rendered ONLY on the Root Workspace (the Tree node with a null server
 * parent). The root decision is data-driven here, not route-driven.
 */
import type {
  Problem,
  TranscriptRes,
  ViewRequestMap,
} from "@arbor/api-contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useViewQuery } from "../../api/useViewQuery.js";
import { SubmitHumanMessageForm } from "../../commands/forms/SubmitHumanMessageForm.js";
import { Empty } from "../../components/Empty.js";
import { streamConversationProgress } from "../../data/conversation-progress.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import { useSession } from "../../session/SessionContext.js";
import { TranscriptView } from "../../views/TranscriptView.js";
import { presentResponsibilityTree } from "../tree/treePresentation.js";
import styles from "./workspace.module.css";

type WorkspaceId = ViewRequestMap["transcript"]["workspaceId"];
type ProjectId = ViewRequestMap["responsibility-tree"]["projectId"];

const TRANSCRIPT_PAGE_SIZE = 20;

const asProblem = (error: unknown): Problem => error as Problem;
const turnKey = (entry: TranscriptRes["entries"][number]): string => {
  if ("messageId" in entry) {
    return `human:${entry.messageId}`;
  }
  if ("executionId" in entry) {
    return `assistant:${entry.executionId}:${entry.occurredAt}`;
  }
  return `other:${entry.kind}:${entry.summaryRef}:${entry.at}`;
};

const mergeConversationEntries = (
  older: TranscriptRes["entries"],
  newer: TranscriptRes["entries"],
): TranscriptRes["entries"] => {
  const entriesByKey = new Map<string, TranscriptRes["entries"][number]>();
  for (const entry of [...older, ...newer]) {
    entriesByKey.set(turnKey(entry), entry);
  }
  return [...entriesByKey.values()].sort((left, right) => {
    const leftAt = "occurredAt" in left ? left.occurredAt : left.at;
    const rightAt = "occurredAt" in right ? right.occurredAt : right.at;
    // Array#sort is stable: for equal timestamps keep the order supplied by
    // the server pages instead of inventing a tie-break that can disagree
    // with the server's cursor order.
    return leftAt.localeCompare(rightAt);
  });
};

interface ScrollAnchor {
  readonly element: HTMLElement;
  readonly top: number;
}

interface PendingPrependRestore {
  readonly expectedKeys: ReadonlyArray<string>;
  readonly anchor: ScrollAnchor | null;
}

const captureVisibleAnchor = (
  scroller: HTMLDivElement,
): ScrollAnchor | null => {
  const scrollerTop = scroller.getBoundingClientRect().top + scroller.clientTop;
  const scrollerBottom = scrollerTop + scroller.clientHeight;
  const turns = scroller.querySelectorAll<HTMLElement>(
    "[data-conversation-turn-key]",
  );
  for (const element of turns) {
    const bounds = element.getBoundingClientRect();
    if (bounds.bottom > scrollerTop && bounds.top < scrollerBottom) {
      return { element, top: bounds.top };
    }
  }
  return null;
};

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
  const queryClient = useQueryClient();
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<TranscriptRes | null>(null);
  const [streamMessageId, setStreamMessageId] = useState<string | null>(null);
  const historyScrollerRef = useRef<HTMLDivElement>(null);
  const historyTopRef = useRef<HTMLDivElement>(null);
  const pendingPrependRestoreRef = useRef<PendingPrependRestore | null>(null);
  const followBottomRef = useRef(true);
  const loadedCursorsRef = useRef(new Set<string>());
  const olderHistoryExhaustedRef = useRef(false);
  const [stream, setStream] = useState<{
    readonly text: string;
    readonly status: "streaming" | "retrying" | "settling" | "unavailable";
  } | null>(null);
  const latestTranscript = useViewQuery("transcript", {
    workspaceId: workspaceId as WorkspaceId,
    limit: TRANSCRIPT_PAGE_SIZE,
    conversationOnly: true,
  });
  const olderTranscript = useViewQuery(
    "transcript",
    olderCursor === null
      ? null
      : {
          workspaceId: workspaceId as WorkspaceId,
          cursor: olderCursor,
          limit: TRANSCRIPT_PAGE_SIZE,
          conversationOnly: true,
        },
  );
  const isRoot = rootWorkspaceId === workspaceId;
  const queuedState =
    history === null ? null : deriveQueuedState(history.entries);

  useEffect(() => {
    if (latestTranscript.data === undefined) {
      return;
    }
    setHistory((previous) =>
      previous === null
        ? latestTranscript.data
        : {
            entries: mergeConversationEntries(
              previous.entries,
              latestTranscript.data.entries,
            ),
            ...(olderHistoryExhaustedRef.current
              ? {}
              : {
                  nextCursor:
                    previous.nextCursor ?? latestTranscript.data.nextCursor,
                }),
          },
    );
  }, [latestTranscript.data]);

  useEffect(() => {
    const cursor = olderCursor;
    const page = olderTranscript.data;
    if (
      cursor === null ||
      page === undefined ||
      loadedCursorsRef.current.has(cursor)
    ) {
      return;
    }
    loadedCursorsRef.current.add(cursor);
    olderHistoryExhaustedRef.current = page.nextCursor === undefined;
    const scroller = historyScrollerRef.current;
    pendingPrependRestoreRef.current = {
      expectedKeys: page.entries.map(turnKey),
      anchor: scroller === null ? null : captureVisibleAnchor(scroller),
    };
    setHistory((previous) => ({
      entries:
        previous === null
          ? page.entries
          : mergeConversationEntries(page.entries, previous.entries),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    }));
    setOlderCursor(null);
  }, [olderCursor, olderTranscript.data]);

  const loadOlder = useCallback((): void => {
    const cursor = history?.nextCursor;
    if (
      cursor === undefined ||
      olderCursor !== null ||
      olderTranscript.isFetching ||
      loadedCursorsRef.current.has(cursor)
    ) {
      return;
    }
    setOlderCursor(cursor);
  }, [history?.nextCursor, olderCursor, olderTranscript.isFetching]);
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;
  const activeOlderCursor = history?.nextCursor;
  const isLoadingOlder = olderCursor !== null || olderTranscript.isFetching;

  useEffect(() => {
    const scroller = historyScrollerRef.current;
    const top = historyTopRef.current;
    if (
      scroller === null ||
      top === null ||
      activeOlderCursor === undefined ||
      isLoadingOlder ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          activeOlderCursor !== undefined &&
          entries.some((entry) => entry.isIntersecting)
        ) {
          loadOlderRef.current();
        }
      },
      { root: scroller, rootMargin: "120px 0px 0px 0px" },
    );
    observer.observe(top);
    return () => observer.disconnect();
  }, [activeOlderCursor, isLoadingOlder]);

  useLayoutEffect(() => {
    if (history === null && stream?.text === undefined) {
      return;
    }
    const scroller = historyScrollerRef.current;
    if (scroller === null) {
      return;
    }
    const pendingRestore = pendingPrependRestoreRef.current;
    if (pendingRestore !== null) {
      const historyKeys = new Set(history?.entries.map(turnKey) ?? []);
      const pageIsPresent = pendingRestore.expectedKeys.every((key) =>
        historyKeys.has(key),
      );
      if (pageIsPresent) {
        if (followBottomRef.current) {
          scroller.scrollTop = scroller.scrollHeight;
        } else if (pendingRestore.anchor?.element.isConnected) {
          const currentTop =
            pendingRestore.anchor.element.getBoundingClientRect().top;
          scroller.scrollTop += currentTop - pendingRestore.anchor.top;
        }
        pendingPrependRestoreRef.current = null;
        return;
      }
    }
    if (followBottomRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [history, stream?.text]);

  const handleHistoryScroll = (): void => {
    const scroller = historyScrollerRef.current;
    if (scroller === null) {
      return;
    }
    const distanceFromBottom =
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    followBottomRef.current = distanceFromBottom < 96;
    if (scroller.scrollTop < 48) {
      loadOlderRef.current();
    }
  };
  useEffect(() => {
    if (streamMessageId === null || session.token === null) {
      return;
    }
    const controller = new AbortController();
    setStream({ text: "", status: "streaming" });
    void streamConversationProgress(
      streamMessageId,
      session.token,
      {
        onEvent: (event) => {
          switch (event.type) {
            case "started":
              setStream((previous) => ({
                text: previous?.text ?? "",
                status: "streaming",
              }));
              break;
            case "delta":
              setStream((previous) => ({
                text: `${previous?.text ?? ""}${event.text}`,
                status: "streaming",
              }));
              break;
            case "reset":
              setStream({ text: "", status: "streaming" });
              break;
            case "retrying":
              setStream({ text: "", status: "retrying" });
              break;
            case "ready":
              setStream((previous) => ({
                text: previous?.text ?? "",
                status: "settling",
              }));
              break;
            case "settled":
            case "interrupted":
              setStream(null);
              setStreamMessageId(null);
              void queryClient.invalidateQueries({
                queryKey: ["view", "transcript"],
              });
              break;
          }
        },
      },
      controller.signal,
    ).catch(() => {
      if (!controller.signal.aborted) {
        setStream((previous) =>
          previous === null
            ? { text: "", status: "unavailable" }
            : { ...previous, status: "unavailable" },
        );
      }
    });
    return () => controller.abort();
  }, [queryClient, session.token, streamMessageId]);
  return (
    <div className={styles.conversation}>
      <p className={styles.conversationLabel}>
        {isRoot ? "根工作区对话" : "对话记录（只读）"}
      </p>
      {latestTranscript.isPending && history === null ? (
        <Empty>加载中</Empty>
      ) : latestTranscript.isError && history === null ? (
        <ProblemCard problem={asProblem(latestTranscript.error)} />
      ) : (
        <div
          className={styles.conversationHistory}
          ref={historyScrollerRef}
          onScroll={handleHistoryScroll}
          aria-label="对话消息"
          role="log"
          aria-live="polite"
        >
          <div
            ref={historyTopRef}
            className={styles.historyTopSentinel}
            aria-hidden="true"
          />
          {olderTranscript.isFetching ? (
            <p className={styles.historyLoading}>正在加载更早的消息…</p>
          ) : null}
          {history === null ? (
            <Empty>无会话记录</Empty>
          ) : (
            <TranscriptView res={history} />
          )}
          {isRoot && stream !== null ? (
            <div className="arbor-conversation-turn arbor-conversation-assistant arbor-conversation-stream">
              <span className="arbor-conversation-author">Arbor</span>
              <span className="arbor-conversation-body">
                {stream.text ||
                  (stream.status === "retrying"
                    ? "正在重试…"
                    : stream.status === "settling"
                      ? "正在保存回复…"
                      : stream.status === "unavailable"
                        ? "实时预览暂不可用，等待正式回复…"
                        : "正在生成…")}
              </span>
            </div>
          ) : null}
        </div>
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
            onMessageSubmitted={(messageId) => {
              followBottomRef.current = true;
              setStreamMessageId(messageId);
            }}
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
      key={workspaceId}
      projectId={projectId}
      workspaceId={workspaceId}
      rootWorkspaceId={presented?.root.workspaceId}
    />
  );
}
