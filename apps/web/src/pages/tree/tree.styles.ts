/** Tailwind utility recipes for this surface; product state stays with its caller. */
const styles = {
  page: "w-full min-w-0 flex flex-col gap-ui-4",
  header: "flex flex-wrap items-baseline justify-between gap-ui-3",
  title: "m-0 font-sans text-display font-semibold text-foreground",
  depthLabel:
    "flex items-center gap-ui-2 text-small text-muted-foreground whitespace-nowrap",
  depthSelect:
    "font-sans text-small text-foreground bg-card border border-solid border-border rounded-sm p-[var(--arbor-space-1)_var(--arbor-space-2)]",
  layout:
    "grid grid-cols-1 gap-ui-4 items-start min-[1280px]:grid-cols-[minmax(0,_1fr)_320px]",
  detail: "min-w-0 min-[1280px]:sticky min-[1280px]:top-ui-3",
  detailBody: "flex flex-col gap-ui-3",
  listSection: "min-w-0",
  list: "flex flex-col gap-ui-3 m-0 p-0 list-none",
  node: "flex flex-col gap-ui-1 w-[calc(100%_-_var(--tree-depth,0)*var(--arbor-space-4))] text-left p-ui-3 ms-[calc(var(--tree-depth,_0)_*_var(--arbor-space-4))] bg-card border border-solid border-border rounded-md shadow-card cursor-pointer [&:hover]:border-branch [&:focus-visible]:[outline:2px_solid_var(--arbor-focus)] [&:focus-visible]:[outline-offset:1px]",
  nodeSelected: "aria-pressed:border-primary aria-pressed:bg-accent",
  nodeHead: "flex items-center flex-wrap gap-ui-2",
  nodeName: "font-sans text-body font-semibold text-foreground",
  nodeObjective: "text-small text-muted-foreground",
  nodeUsage: "font-mono text-caption text-subtle wrap-anywhere",
} as const;
export default styles;
