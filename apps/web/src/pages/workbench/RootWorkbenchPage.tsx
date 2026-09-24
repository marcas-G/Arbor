import {
  type CSSProperties,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Route } from "../../api/router.js";
import { Button } from "../../components/Button.js";
import { Empty } from "../../components/Empty.js";
import { MonoText } from "../../components/MonoText.js";
import styles from "./workbench.module.css";

export type WorkbenchPaneOrder = "tree-first" | "conversation-first";

export type WorkbenchLayoutPreference = {
  readonly order: WorkbenchPaneOrder;
  readonly treeBasis: number;
};

export const WORKBENCH_LAYOUT_KEY = "arbor.workbench-layout.v1";
export const DEFAULT_WORKBENCH_LAYOUT: WorkbenchLayoutPreference = {
  order: "tree-first",
  treeBasis: 42,
};

const MIN_TREE_BASIS = 30;
const MAX_TREE_BASIS = 70;

const isPaneOrder = (value: unknown): value is WorkbenchPaneOrder =>
  value === "tree-first" || value === "conversation-first";

const clampTreeBasis = (value: number): number =>
  Math.min(MAX_TREE_BASIS, Math.max(MIN_TREE_BASIS, Math.round(value)));

/** Parses only the versioned, presentation-only preference shape. */
export const parseWorkbenchLayout = (
  serialized: string | null,
): WorkbenchLayoutPreference => {
  if (serialized === null) {
    return DEFAULT_WORKBENCH_LAYOUT;
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return DEFAULT_WORKBENCH_LAYOUT;
    }
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== "order" ||
      keys[1] !== "treeBasis" ||
      !isPaneOrder(record.order) ||
      typeof record.treeBasis !== "number" ||
      !Number.isFinite(record.treeBasis) ||
      record.treeBasis < MIN_TREE_BASIS ||
      record.treeBasis > MAX_TREE_BASIS
    ) {
      return DEFAULT_WORKBENCH_LAYOUT;
    }
    return { order: record.order, treeBasis: Math.round(record.treeBasis) };
  } catch {
    return DEFAULT_WORKBENCH_LAYOUT;
  }
};

const readWorkbenchLayout = (): WorkbenchLayoutPreference => {
  try {
    return parseWorkbenchLayout(localStorage.getItem(WORKBENCH_LAYOUT_KEY));
  } catch {
    return DEFAULT_WORKBENCH_LAYOUT;
  }
};

function useWorkbenchLayout() {
  const [layout, setLayout] =
    useState<WorkbenchLayoutPreference>(readWorkbenchLayout);
  useEffect(() => {
    try {
      localStorage.setItem(WORKBENCH_LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // A disabled storage area merely means the local presentation preference
      // is transient; it must never affect the Workbench's server facts.
    }
  }, [layout]);
  return [layout, setLayout] as const;
}

function TreePane({ hiddenOnMobile }: { readonly hiddenOnMobile: boolean }) {
  return (
    <section
      className={`${styles.pane} ${styles.treePane} ${hiddenOnMobile ? styles.mobileHidden : ""}`}
      aria-labelledby="workbench-tree-title"
    >
      <header className={styles.paneHeader}>
        <div>
          <p className={styles.eyebrow}>组织视图</p>
          <h2 id="workbench-tree-title">责任树</h2>
        </div>
        <span className={styles.paneState}>准备就绪</span>
      </header>
      <Empty>责任树将在连接到项目视图后显示。</Empty>
    </section>
  );
}

function ConversationPane({
  hiddenOnMobile,
}: {
  readonly hiddenOnMobile: boolean;
}) {
  return (
    <section
      className={`${styles.pane} ${styles.conversationPane} ${hiddenOnMobile ? styles.mobileHidden : ""}`}
      aria-labelledby="workbench-conversation-title"
    >
      <header className={styles.paneHeader}>
        <div>
          <p className={styles.eyebrow}>协作上下文</p>
          <h2 id="workbench-conversation-title">对话</h2>
        </div>
        <span className={styles.paneState}>等待选择</span>
      </header>
      <Empty>从责任树选择工作区后，在这里查看对话上下文。</Empty>
    </section>
  );
}

/**
 * D3 product landing: local shell only. Tree/transcript data and command
 * affordances remain owned by later authorized surfaces, never by this page.
 */
export function RootWorkbenchPage({
  route,
}: {
  readonly route: Extract<Route, { readonly name: "workbench" }>;
}) {
  const [layout, setLayout] = useWorkbenchLayout();
  const [mobilePane, setMobilePane] = useState<"tree" | "conversation">(
    "conversation",
  );
  const layoutRef = useRef<HTMLDivElement>(null);
  const stopResizeRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      stopResizeRef.current?.();
    },
    [],
  );

  const setTreeBasis = (value: number): void => {
    setLayout((previous) => ({
      ...previous,
      treeBasis: clampTreeBasis(value),
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
    resize(event.nativeEvent);
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
          <TreePane key="tree" hiddenOnMobile={mobilePane !== "tree"} />,
          <ConversationPane
            key="conversation"
            hiddenOnMobile={mobilePane !== "conversation"}
          />,
        ]
      : [
          <ConversationPane
            key="conversation"
            hiddenOnMobile={mobilePane !== "conversation"}
          />,
          <TreePane key="tree" hiddenOnMobile={mobilePane !== "tree"} />,
        ];
  const layoutStyle = {
    "--workbench-tree-basis": `${String(layout.treeBasis)}%`,
  } as CSSProperties;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Arbor Workbench</p>
          <h1>工作台</h1>
          <p className={styles.intro}>
            以责任树组织工作，并在对话中保持协作上下文。
          </p>
        </div>
        <div className={styles.projectMeta}>
          <span>项目</span>
          <MonoText>{route.projectId}</MonoText>
        </div>
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
          责任树
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
        <Button variant="quiet" onClick={swapPanes}>
          交换树与对话位置
        </Button>
        <Button variant="quiet" onClick={resetTreeBasis}>
          重置分栏比例
        </Button>
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
          aria-label="调整责任树与对话比例"
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
