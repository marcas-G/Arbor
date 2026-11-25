/** Tailwind utility recipes for this surface; product state stays with its caller. */
const styles = {
  page: "w-full min-w-0 flex flex-col gap-ui-3 min-w-0",
  header: "flex items-end justify-between gap-ui-3 flex-wrap",
  heading: "m-0 font-sans text-display text-foreground",
  eyebrow:
    "m-[0_0_var(--arbor-space-1)] text-primary font-mono text-caption tracking-[0.04em] uppercase",
  intro: "max-w-[32rem] m-0 text-muted-foreground text-small",
  refreshing: "m-0 text-muted-foreground text-small",
  pendingNote: "m-0 text-muted-foreground text-small",
  sourceProblem:
    "flex flex-col gap-ui-2 [&_h2]:m-0 [&_h2]:text-foreground [&_h2]:text-small",
  masterDetail:
    "grid grid-cols-[minmax(18rem,_0.85fr)_minmax(24rem,_1.15fr)] items-start gap-ui-3 min-w-0 max-[63.99rem]:grid-cols-1",
  listPanel:
    "min-w-0 border border-solid border-border rounded-md bg-card flex flex-col gap-ui-2 p-ui-3",
  detailPanel:
    "min-w-0 border border-solid border-border rounded-md bg-card min-h-[22rem] p-ui-4 max-[63.99rem]:hidden",
  listHeader:
    "flex items-center justify-between gap-ui-2 pb-ui-2 border-b border-solid border-border [&_h2]:m-0 [&_h2]:text-foreground [&_h2]:text-title",
  list: "flex flex-col gap-ui-2 m-0 p-0 list-none",
  itemButton:
    'flex flex-col items-stretch gap-ui-2 w-full min-w-0 p-ui-3 border border-solid border-border border-l-[3px] border-l-attention rounded-sm bg-card text-foreground font-sans text-left cursor-pointer [&:hover]:border-primary [&:hover]:bg-accent [&[aria-pressed="true"]]:border-primary [&[aria-pressed="true"]]:bg-accent [&:focus-visible]:[outline:2px_solid_var(--arbor-focus)] [&:focus-visible]:[outline-offset:2px]',
  itemMeta: "flex items-center justify-between gap-ui-2 flex-wrap",
  itemSummary: "text-body font-semibold wrap-anywhere",
  itemTarget: "text-muted-foreground font-mono text-caption wrap-anywhere",
  approvalPreview:
    "max-h-[16rem] m-0 p-ui-2 overflow-auto border border-solid border-border rounded-sm bg-card text-foreground font-mono text-caption whitespace-pre-wrap wrap-anywhere",
  expiredApproval:
    "m-0 p-ui-2 border-l-[3px] border-solid border-attention bg-card text-muted-foreground",
  detailContent:
    "flex flex-col items-start gap-ui-3 min-w-0 [&_h2]:w-full [&_h2]:m-0 [&_h2]:text-foreground [&_h2]:font-sans [&_h2]:text-title [&_h2]:wrap-anywhere",
  detailTopline: "flex items-center gap-ui-2 flex-wrap",
  detailWorkspace: "text-muted-foreground font-mono text-caption wrap-anywhere",
  receiptCommitted: "m-0 p-ui-2 rounded-sm text-small bg-accent text-primary",
  receiptRejected:
    "m-0 p-ui-2 rounded-sm text-small bg-card text-destructive border border-solid border-destructive",
  targetList:
    "grid w-full min-w-0 gap-ui-2 text-small [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:wrap-anywhere",
} as const;
export default styles;
