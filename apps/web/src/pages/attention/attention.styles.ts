/** Tailwind utility recipes for this surface; product state stays with its caller. */
const styles = {
  page: "w-full min-w-0 flex flex-col gap-ui-3 min-w-0",
  header:
    "flex flex-wrap items-end justify-between gap-[var(--arbor-space-2)_var(--arbor-space-3)]",
  title: "m-0 font-sans text-display text-foreground",
  eyebrow:
    "m-[0_0_var(--arbor-space-1)] text-primary font-mono text-caption tracking-[0.04em] uppercase",
  caption: "text-caption text-subtle",
  refreshing: "m-0 text-muted-foreground text-small",
  staleProblem:
    "flex flex-col gap-ui-2 [&>_p]:m-0 [&>_p]:text-muted-foreground",
  filterBar:
    "flex flex-wrap items-center gap-ui-2 m-0 p-ui-2 border border-solid border-border rounded-md bg-card [min-inline-size:0]",
  filterLegend: "p-0 text-caption text-subtle",
  chip: 'inline-flex items-center gap-ui-1 p-[var(--arbor-space-1)_var(--arbor-space-2)] border border-solid border-border rounded-sm bg-card text-foreground font-sans text-small cursor-pointer whitespace-nowrap [&[aria-pressed="true"]]:border-primary [&[aria-pressed="true"]]:bg-accent [&:focus-visible]:[outline:2px_solid_var(--arbor-focus)] [&:focus-visible]:[outline-offset:-2px]',
  groups: "flex flex-col gap-ui-3 min-w-0",
  inspectionLayout:
    "grid grid-cols-[minmax(0,_1.1fr)_minmax(20rem,_0.9fr)] items-start gap-ui-3 min-w-0 max-[63.99rem]:grid-cols-1",
  group:
    "flex flex-col gap-ui-2 p-ui-3 border border-solid border-border rounded-md bg-card min-w-0",
  groupTitle:
    "flex items-center gap-ui-2 m-0 font-sans text-body text-foreground",
  rowList: "flex flex-col gap-ui-1 m-0 p-0 list-none",
  rowButton:
    'flex flex-wrap items-center justify-between w-full min-w-0 gap-[var(--arbor-space-2)_var(--arbor-space-3)] p-ui-2 border border-solid border-border border-l-[3px] border-l-attention rounded-sm bg-card text-foreground font-sans text-left cursor-pointer [&:hover]:border-primary [&:hover]:bg-accent [&[aria-pressed="true"]]:border-primary [&[aria-pressed="true"]]:bg-accent [&:focus-visible]:[outline:2px_solid_var(--arbor-focus)] [&:focus-visible]:[outline-offset:2px]',
  rowMeta: "flex flex-wrap items-center gap-ui-1",
  targetPreview: "text-muted-foreground text-caption wrap-anywhere",
  inspectionPanel:
    "sticky top-ui-3 min-w-0 min-h-[20rem] p-ui-3 border border-solid border-border rounded-md bg-card max-[63.99rem]:hidden",
  inspection: "flex flex-col items-start gap-ui-3 min-w-0",
  inspectionHeading:
    "flex items-start justify-between w-full gap-ui-2 [&_h2]:m-0 [&_h2]:text-foreground [&_h2]:text-title [&_h2]:wrap-anywhere",
  inspectionFields:
    "grid grid-cols-1 w-full gap-ui-2 m-0 [&>_div]:grid [&>_div]:grid-cols-[minmax(7rem,_0.7fr)_minmax(0,_1.3fr)] [&>_div]:items-start [&>_div]:gap-ui-2 [&>_div]:pb-ui-2 [&>_div]:border-b [&>_div]:border-solid [&>_div]:border-border [&>_div]:min-w-0 [&_dt]:text-muted-foreground [&_dt]:text-caption [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:wrap-anywhere",
  readOnlyNote: "m-0 text-subtle text-small",
} as const;
export default styles;
