import type { ViewRequestMap } from "@arbor/api-contracts";
import {
  type CSSProperties,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Route } from "../../api/router.js";
import { navigate } from "../../api/router.js";
import { problemFromUnknown } from "../../api/transport.js";
import { useViewQuery } from "../../api/useViewQuery.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { Empty } from "../../components/Empty.js";
import { Icon } from "../../components/Icon.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import { presentResponsibilityTree } from "../tree/treePresentation.js";
import { ConversationTab } from "../workspace/ConversationTab.js";
import {
  clampWorkbenchTreeBasis,
  DEFAULT_WORKBENCH_LAYOUT,
  MAX_TREE_BASIS,
  MIN_TREE_BASIS,
  useWorkbenchLayoutPreference,
} from "./layoutPreference.js";
import styles from "./workbench.module.css";

type ProjectId = ViewRequestMap["responsibility-tree"]["projectId"];

export {
  DEFAULT_WORKBENCH_LAYOUT,
  parseWorkbenchLayout,
  WORKBENCH_LAYOUT_KEY,
  type WorkbenchLayoutPreference,
  type WorkbenchPaneOrder,
} from "./layoutPreference.js";

function TreePane({
  projectId,
  hiddenOnMobile,
}: {
  readonly projectId: string;
  readonly hiddenOnMobile: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const tree = useViewQuery("responsibility-tree", {
    projectId: projectId as ProjectId,
  });
  const presented =
    tree.data === undefined
      ? undefined
      : presentResponsibilityTree(tree.data.nodes);
  const selected = tree.data?.nodes.find(
    (node) => node.workspaceId === selectedId,
  );
  return (
    <section
      className={`${styles.pane} ${styles.treePane} ${hiddenOnMobile ? styles.mobileHidden : ""}`}
      aria-labelledby="workbench-tree-title"
    >
      <header className={styles.paneHeader}>
        <div className={styles.paneTitleGroup}>
          <span className={styles.paneIcon}>
            <Icon name="tree" size={18} />
          </span>
          <div>
            <p className={styles.eyebrow}>项目结构</p>
            <h2 id="workbench-tree-title">工作分工</h2>
          </div>
        </div>
        <Button
          variant="quiet"
          onClick={() => {
            navigate({ name: "tree", projectId });
          }}
        >
          查看完整结构
        </Button>
      </header>
      {tree.isPending ? (
        <Empty>正在加载工作分工</Empty>
      ) : tree.isError ? (
        <ProblemCard
          problem={problemFromUnknown(tree.error)}
          onRetry={() => {
            void tree.refetch();
          }}
        />
      ) : presented === null || presented === undefined ? (
        <Empty>项目结构暂不可用，请刷新后重试</Empty>
      ) : (
        <>
          <ul className={styles.treeList} aria-label="工作分工">
            {tree.data.nodes.map((node) => {
              const depth =
                presented.depths.get(node.workspaceId as string) ?? 0;
              return (
                <li key={node.workspaceId}>
                  <button
                    type="button"
                    className={styles.treeNode}
                    aria-pressed={node.workspaceId === selectedId}
                    style={
                      {
                        "--workbench-tree-depth": String(depth),
                      } as CSSProperties
                    }
                    onClick={() => {
                      setSelectedId(node.workspaceId);
                    }}
                  >
                    <span className={styles.treeNodeHead}>
                      <span>{node.name}</span>
                      <StatusBadge label={node.status} />
                    </span>
                    {node.currentWork === undefined ? null : (
                      <span className={styles.treeNodeSummary}>
                        {node.currentWork.objective}
                      </span>
                    )}
                    {node.subtreeAttention.attention === 0 &&
                    node.subtreeAttention.actionRequired === 0 ? null : (
                      <span className={styles.treeNodeBadges}>
                        {node.subtreeAttention.attention === 0 ? null : (
                          <Badge tone="attention">{`需关注 ${String(node.subtreeAttention.attention)}`}</Badge>
                        )}
                        {node.subtreeAttention.actionRequired === 0 ? null : (
                          <Badge tone="danger">{`需要处理 ${String(node.subtreeAttention.actionRequired)}`}</Badge>
                        )}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {selected === undefined ? (
            <p className={styles.treeInspection}>选择一项分工查看当前工作。</p>
          ) : (
            <div className={styles.treeInspection}>
              <strong>{selected.name}</strong>
              <span>{selected.currentWork?.objective ?? "无当前工作"}</span>
              <Button
                variant="quiet"
                onClick={() => {
                  navigate({
                    name: "workspace",
                    projectId,
                    workspaceId: selected.workspaceId,
                    tab: "overview",
                  });
                }}
              >
                查看工作
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ConversationPane({
  projectId,
  hiddenOnMobile,
}: {
  readonly projectId: string;
  readonly hiddenOnMobile: boolean;
}) {
  const tree = useViewQuery("responsibility-tree", {
    projectId: projectId as ProjectId,
  });
  const presented =
    tree.data === undefined
      ? undefined
      : presentResponsibilityTree(tree.data.nodes);
  return (
    <section
      className={`${styles.pane} ${styles.conversationPane} ${hiddenOnMobile ? styles.mobileHidden : ""}`}
      aria-labelledby="workbench-conversation-title"
    >
      <header className={styles.paneHeader}>
        <div className={styles.paneTitleGroup}>
          <span className={styles.paneIcon}>
            <Icon name="conversation" size={18} />
          </span>
          <div>
            <p className={styles.eyebrow}>项目对话</p>
            <h2 id="workbench-conversation-title">对话</h2>
          </div>
        </div>
        <span className={styles.paneState}>项目主对话</span>
      </header>
      {tree.isPending ? (
        <Empty>正在准备项目对话</Empty>
      ) : tree.isError ? (
        <ProblemCard
          problem={problemFromUnknown(tree.error)}
          onRetry={() => {
            void tree.refetch();
          }}
        />
      ) : presented === null || presented === undefined ? (
        <Empty>项目结构暂不可用，无法打开项目对话。</Empty>
      ) : (
        <ConversationTab
          projectId={projectId}
          workspaceId={presented.root.workspaceId}
        />
      )}
    </section>
  );
}

/**
 * D6 product landing: tree and conversation are server views; layout remains
 * a local presentation preference only.
 */
export function RootWorkbenchPage({
  route,
}: {
  readonly route: Extract<Route, { readonly name: "workbench" }>;
}) {
  const [layout, setLayout] = useWorkbenchLayoutPreference();
  const [mobilePane, setMobilePane] = useState<"tree" | "conversation">(
    "conversation",
  );
  const layoutRef = useRef<HTMLDivElement>(null);
  const stopResizeRef = useRef<(() => void) | null>(null);
  const projectTree = useViewQuery("responsibility-tree", {
    projectId: route.projectId as ProjectId,
  });
  const projectTreePresented =
    projectTree.data === undefined
      ? undefined
      : presentResponsibilityTree(projectTree.data.nodes);
  const projectOverview =
    projectTree.data === undefined ||
    projectTreePresented === undefined ||
    projectTreePresented === null
      ? undefined
      : {
          rootName: projectTreePresented.root.name,
          workspaceCount: projectTree.data.nodes.length,
          runningCount: projectTree.data.nodes.filter(
            (node) => node.currentWork?.activeExecution != null,
          ).length,
          attention: projectTreePresented.root.subtreeAttention.attention,
          actionRequired:
            projectTreePresented.root.subtreeAttention.actionRequired,
        };

  useEffect(
    () => () => {
      stopResizeRef.current?.();
    },
    [],
  );

  const setTreeBasis = (value: number): void => {
    setLayout((previous) => ({
      ...previous,
      treeBasis: clampWorkbenchTreeBasis(value),
    }));
  };

  const startResize = (event: PointerEvent<HTMLHRElement>): void => {
    const bounds = layoutRef.current?.getBoundingClientRect();
    if (bounds === undefined || bounds.width <= 0) {
      return;
    }
    stopResizeRef.current?.();
    const divider = event.currentTarget;
    divider.setPointerCapture?.(event.pointerId);
    const resize = (move: globalThis.PointerEvent): void => {
      const fromLeft = ((move.clientX - bounds.left) / bounds.width) * 100;
      setTreeBasis(layout.order === "tree-first" ? fromLeft : 100 - fromLeft);
    };
    const stop = (): void => {
      document.removeEventListener("pointermove", resize);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      divider.removeEventListener("lostpointercapture", stop);
      if (stopResizeRef.current === stop) {
        stopResizeRef.current = null;
      }
    };
    document.addEventListener("pointermove", resize);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
    divider.addEventListener("lostpointercapture", stop);
    stopResizeRef.current = stop;
  };

  const swapPanes = (): void => {
    setLayout((previous) => ({
      ...previous,
      order:
        previous.order === "tree-first" ? "conversation-first" : "tree-first",
    }));
  };

  const resetTreeBasis = (): void => {
    setTreeBasis(DEFAULT_WORKBENCH_LAYOUT.treeBasis);
  };

  const panes =
    layout.order === "tree-first"
      ? [
          <TreePane
            key="tree"
            projectId={route.projectId}
            hiddenOnMobile={mobilePane !== "tree"}
          />,
          <ConversationPane
            key="conversation"
            projectId={route.projectId}
            hiddenOnMobile={mobilePane !== "conversation"}
          />,
        ]
      : [
          <ConversationPane
            key="conversation"
            projectId={route.projectId}
            hiddenOnMobile={mobilePane !== "conversation"}
          />,
          <TreePane
            key="tree"
            projectId={route.projectId}
            hiddenOnMobile={mobilePane !== "tree"}
          />,
        ];
  const layoutStyle = {
    "--workbench-tree-basis": `${String(layout.treeBasis)}%`,
  } as CSSProperties;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.headingBlock}>
          <span className={styles.headingIcon}>
            <Icon name="workbench" size={21} />
          </span>
          <div>
            <p className={styles.eyebrow}>项目主页</p>
            <h1>工作台</h1>
            <p className={styles.intro}>
              从一次对话开始，让项目分工承接持续推进的工作。
            </p>
          </div>
        </div>
        {projectOverview === undefined ? null : (
          <section className={styles.projectOverview} aria-label="项目概览">
            <div className={styles.projectRoot}>
              <span className={styles.liveDot} />
              <strong>{`主要分工：${projectOverview.rootName}`}</strong>
            </div>
            <dl className={styles.projectStats}>
              <div>
                <dt>分工数量</dt>
                <dd>{projectOverview.workspaceCount}</dd>
              </div>
              <div>
                <dt>正在运行</dt>
                <dd>{projectOverview.runningCount}</dd>
              </div>
              <div>
                <dt>需要关注</dt>
                <dd>{projectOverview.attention}</dd>
              </div>
              <div>
                <dt>需要处理</dt>
                <dd>{projectOverview.actionRequired}</dd>
              </div>
            </dl>
          </section>
        )}
      </header>

      <fieldset className={styles.mobileTabs} aria-label="工作台面板">
        <button
          type="button"
          aria-pressed={mobilePane === "tree"}
          className={
            mobilePane === "tree" ? styles.mobileTabActive : styles.mobileTab
          }
          onClick={() => setMobilePane("tree")}
        >
          工作分工
        </button>
        <button
          type="button"
          aria-pressed={mobilePane === "conversation"}
          className={
            mobilePane === "conversation"
              ? styles.mobileTabActive
              : styles.mobileTab
          }
          onClick={() => setMobilePane("conversation")}
        >
          对话
        </button>
      </fieldset>

      <div className={styles.layoutActions}>
        <span className={styles.layoutHint}>工作台布局</span>
        <div className={styles.layoutButtons}>
          <Button variant="quiet" onClick={swapPanes}>
            交换分工与对话位置
          </Button>
          <Button variant="quiet" onClick={resetTreeBasis}>
            重置分栏比例
          </Button>
        </div>
      </div>

      <div
        ref={layoutRef}
        className={styles.workbench}
        style={layoutStyle}
        data-testid="workbench-layout"
        data-order={layout.order}
        data-tree-basis={layout.treeBasis}
        data-mobile-pane={mobilePane}
      >
        {panes[0]}
        <hr
          aria-orientation="vertical"
          aria-label="调整工作分工与对话比例"
          aria-valuemin={MIN_TREE_BASIS}
          aria-valuemax={MAX_TREE_BASIS}
          aria-valuenow={layout.treeBasis}
          tabIndex={0}
          className={styles.divider}
          onPointerDown={startResize}
          onDoubleClick={resetTreeBasis}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              setTreeBasis(layout.treeBasis - 2);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              setTreeBasis(layout.treeBasis + 2);
            } else if (event.key === "Home") {
              event.preventDefault();
              setTreeBasis(MIN_TREE_BASIS);
            } else if (event.key === "End") {
              event.preventDefault();
              setTreeBasis(MAX_TREE_BASIS);
            }
          }}
        />
        {panes[1]}
      </div>
    </div>
  );
}
