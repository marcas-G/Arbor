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
      className={`flex min-h-[32rem] min-w-0 flex-col gap-3 p-5 max-[80rem]:p-3 max-[64rem]:min-h-64 max-[48rem]:min-h-[22rem] border-0 border-r border-solid border-border bg-background/45 group-data-[order=conversation-first]/workbench:border-r-0 group-data-[order=conversation-first]/workbench:border-l max-[64rem]:border-r-0 max-[64rem]:border-b max-[64rem]:group-data-[order=conversation-first]/workbench:border-l-0 ${hiddenOnMobile ? "max-[48rem]:hidden" : ""}`}
      aria-labelledby="workbench-tree-title"
    >
      <header className="flex min-h-11 items-center justify-between gap-2 border-0 border-b border-solid border-border pb-3 [&_h2]:m-0 [&_h2]:text-title [&_h2]:font-bold [&_h2]:tracking-tight">
        <div className="flex items-center gap-2">
          <span className="grid size-[34px] place-items-center rounded-sm border border-solid border-border bg-card text-primary">
            <Icon name="tree" size={18} />
          </span>
          <div>
            <p className="m-0 mb-0.5 text-caption font-bold tracking-[0.08em] text-primary uppercase">
              项目结构
            </p>
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
          <ul
            className="m-0 flex list-none flex-col gap-2 p-0"
            aria-label="工作分工"
          >
            {tree.data.nodes.map((node) => {
              const depth =
                presented.depths.get(node.workspaceId as string) ?? 0;
              return (
                <li key={node.workspaceId}>
                  <button
                    type="button"
                    className="relative ms-[calc(var(--workbench-tree-depth,0)*var(--arbor-space-4))] flex w-[calc(100%-(var(--workbench-tree-depth,0)*var(--arbor-space-4)))] cursor-pointer flex-col gap-1 rounded-md border border-solid border-border bg-card p-3 text-left font-sans text-foreground transition hover:-translate-y-px hover:border-border-strong hover:shadow-card aria-pressed:border-primary/45 aria-pressed:bg-accent aria-pressed:shadow-[inset_3px_0_0_var(--arbor-leaf)]"
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
                    <span className="flex flex-wrap items-center justify-between gap-1 [&>span:first-child]:font-semibold">
                      <span>{node.name}</span>
                      <StatusBadge label={node.status} />
                    </span>
                    {node.currentWork === undefined ? null : (
                      <span className="line-clamp-2 text-small leading-[1.45] text-muted-foreground">
                        {node.currentWork.objective}
                      </span>
                    )}
                    {node.subtreeAttention.attention === 0 &&
                    node.subtreeAttention.actionRequired === 0 ? null : (
                      <span className="flex flex-wrap items-center gap-1">
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
            <p className="mt-auto flex flex-col gap-2 rounded-md border border-solid border-border bg-card p-3 text-small text-muted-foreground">
              选择一项分工查看当前工作。
            </p>
          ) : (
            <div className="mt-auto flex flex-col gap-2 rounded-md border border-solid border-border bg-card p-3 text-small text-muted-foreground">
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
      className={`flex min-h-[32rem] min-w-0 flex-col gap-3 p-5 max-[80rem]:p-3 max-[64rem]:min-h-64 max-[48rem]:min-h-[22rem] bg-card ${hiddenOnMobile ? "max-[48rem]:hidden" : ""}`}
      aria-labelledby="workbench-conversation-title"
    >
      <header className="flex min-h-11 items-center justify-between gap-2 border-0 border-b border-solid border-border pb-3 [&_h2]:m-0 [&_h2]:text-title [&_h2]:font-bold [&_h2]:tracking-tight">
        <div className="flex items-center gap-2">
          <span className="grid size-[34px] place-items-center rounded-sm border border-solid border-border bg-card text-primary">
            <Icon name="conversation" size={18} />
          </span>
          <div>
            <p className="m-0 mb-0.5 text-caption font-bold tracking-[0.08em] text-primary uppercase">
              项目对话
            </p>
            <h2 id="workbench-conversation-title">对话</h2>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-solid border-primary/20 bg-accent px-2 py-1 text-caption font-semibold text-primary before:size-1.5 before:rounded-full before:bg-accent-foreground before:content-['']">
          项目主对话
        </span>
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <header className="flex items-center justify-between gap-ui-5 pt-2 pb-3 max-[80rem]:flex-col max-[80rem]:items-start max-[80rem]:gap-3 [&_h1]:m-0 [&_h1]:text-display [&_h1]:font-bold [&_h1]:tracking-tight">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-[42px] shrink-0 place-items-center rounded-md border border-solid border-primary/20 bg-accent text-primary max-[48rem]:hidden">
            <Icon name="workbench" size={21} />
          </span>
          <div>
            <p className="m-0 mb-0.5 text-caption font-bold tracking-[0.08em] text-primary uppercase">
              项目主页
            </p>
            <h1>工作台</h1>
            <p className="m-0 mt-1 max-w-[40rem] text-small text-muted-foreground">
              从一次对话开始，让项目分工承接持续推进的工作。
            </p>
          </div>
        </div>
        {projectOverview === undefined ? null : (
          <section
            className="flex min-w-0 items-center gap-5 rounded-md border border-solid border-border bg-card px-3 py-2 shadow-card max-[80rem]:w-full max-[64rem]:flex-col max-[64rem]:items-stretch"
            aria-label="项目概览"
          >
            <div className="grid min-w-36 grid-cols-[auto_1fr] items-center gap-x-2 gap-y-px text-caption text-muted-foreground [&_strong]:col-start-2 [&_strong]:truncate [&_strong]:text-small [&_strong]:font-semibold [&_strong]:text-foreground">
              <span className="row-start-1 size-2 rounded-full border-2 border-solid border-card bg-accent-foreground shadow-[0_0_0_3px_var(--arbor-leaf-pale)]" />
              <strong>{`主要分工：${projectOverview.rootName}`}</strong>
            </div>
            <dl className="m-0 grid flex-1 grid-cols-4 gap-3 border-0 border-l border-solid border-border pl-5 max-[64rem]:border-t max-[64rem]:border-l-0 max-[64rem]:pt-3 max-[64rem]:pl-0 max-[48rem]:grid-cols-2 [&>div]:min-w-0 [&_dt]:truncate [&_dt]:text-caption [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:mt-0.5 [&_dd]:text-title [&_dd]:font-bold">
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

      <fieldset
        className="m-0 hidden min-w-0 gap-2 border-0 p-0 max-[48rem]:flex"
        aria-label="工作台面板"
      >
        <button
          type="button"
          aria-pressed={mobilePane === "tree"}
          className={
            mobilePane === "tree"
              ? "min-h-[var(--arbor-row-height)] flex-1 rounded-sm border border-solid border-primary bg-accent font-sans text-small font-semibold text-primary"
              : "min-h-[var(--arbor-row-height)] flex-1 rounded-sm border border-solid border-border bg-card font-sans text-small font-semibold text-muted-foreground"
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
              ? "min-h-[var(--arbor-row-height)] flex-1 rounded-sm border border-solid border-primary bg-accent font-sans text-small font-semibold text-primary"
              : "min-h-[var(--arbor-row-height)] flex-1 rounded-sm border border-solid border-border bg-card font-sans text-small font-semibold text-muted-foreground"
          }
          onClick={() => setMobilePane("conversation")}
        >
          对话
        </button>
      </fieldset>

      <div className="flex min-h-9 items-center justify-between gap-3 max-[48rem]:hidden">
        <span className="text-caption font-semibold text-muted-foreground">
          工作台布局
        </span>
        <div className="flex gap-1 [&_.arbor-button]:min-h-8 [&_.arbor-button]:py-0 [&_.arbor-button]:text-caption [&_.arbor-button]:text-muted-foreground">
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
        className="group/workbench grid min-h-0 flex-1 grid-cols-[minmax(0,var(--workbench-tree-basis))_6px_minmax(0,1fr)] items-stretch overflow-hidden rounded-lg border border-solid border-border bg-card shadow-card data-[order=conversation-first]:grid-cols-[minmax(0,1fr)_6px_minmax(0,var(--workbench-tree-basis))] max-[64rem]:grid-cols-1 max-[64rem]:overflow-visible max-[64rem]:data-[order=conversation-first]:grid-cols-1"
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
          className="relative z-10 m-0 w-full cursor-col-resize touch-none border-0 bg-background after:absolute after:top-1/2 after:left-1/2 after:h-[var(--arbor-space-5)] after:w-[3px] after:-translate-1/2 after:rounded-full after:bg-border-strong after:content-[''] hover:after:bg-accent-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring max-[64rem]:hidden"
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
