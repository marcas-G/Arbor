import { useEffect, useState } from "react";

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

export const MIN_TREE_BASIS = 30;
export const MAX_TREE_BASIS = 70;
const isPaneOrder = (value: unknown): value is WorkbenchPaneOrder =>
  value === "tree-first" || value === "conversation-first";

export const clampWorkbenchTreeBasis = (value: number): number =>
  Math.min(MAX_TREE_BASIS, Math.max(MIN_TREE_BASIS, Math.round(value)));

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

export function useWorkbenchLayoutPreference() {
  const [layout, setLayout] =
    useState<WorkbenchLayoutPreference>(readWorkbenchLayout);
  useEffect(() => {
    try {
      localStorage.setItem(WORKBENCH_LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // A disabled storage area only makes this presentation preference
      // transient; it must never affect the Workbench's server facts.
    }
  }, [layout]);
  return [layout, setLayout] as const;
}
