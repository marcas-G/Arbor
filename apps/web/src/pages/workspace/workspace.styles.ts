/** Tailwind utility recipes for this surface; product state stays with its caller. */
const styles = {
  page: "w-full min-w-0 flex min-w-0 flex-col gap-ui-3",
  header:
    "flex flex-wrap justify-between gap-ui-4 p-ui-4 border border-solid border-border rounded-md bg-card max-[63.99rem]:p-ui-3",
  headerMain: "flex flex-1 flex-col gap-ui-2 min-w-0",
  idLine: "flex flex-wrap items-center gap-ui-2",
  attentionRow: "flex flex-wrap gap-ui-1",
  metaLine: "flex flex-wrap items-center gap-ui-2",
  purpose: "m-0 font-sans text-body text-foreground",
  boundary: "m-0 text-small text-muted-foreground wrap-anywhere",
  governance: "flex flex-col items-end gap-ui-1 max-[63.99rem]:items-stretch",
  governanceCaption: "text-caption text-subtle",
  governanceActions: "flex flex-wrap gap-ui-2 max-[63.99rem]:[&>_*]:flex-1",
  tabPanel: "flex min-w-0 flex-col gap-ui-3",
  pendingList: "flex flex-col gap-ui-1 m-0 p-0 list-none",
  pendingRow:
    "flex flex-wrap items-baseline gap-ui-2 p-[var(--arbor-space-1)_var(--arbor-space-2)] border border-solid border-border rounded-sm bg-card text-foreground font-sans text-body text-left cursor-pointer [&:hover]:border-accent-foreground [&:focus-visible]:[outline:2px_solid_var(--arbor-focus)] [&:focus-visible]:[outline-offset:-2px]",
} as const;
export default styles;
