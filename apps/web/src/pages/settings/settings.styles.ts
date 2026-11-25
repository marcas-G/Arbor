/** Tailwind utility recipes for this surface; product state stays with its caller. */
const styles = {
  page: "w-full min-w-0 flex flex-col gap-ui-5 min-w-0 w-full",
  pageHeader: "flex items-end justify-between gap-ui-3",
  eyebrow:
    "m-[0_0_var(--arbor-space-1)] text-primary text-caption font-bold tracking-[0.08em] uppercase",
  title:
    "m-0 font-sans text-display [font-weight:720] text-foreground tracking-[-0.03em]",
  pageIntro: "m-[var(--arbor-space-1)_0_0] text-muted-foreground text-small",
  settingsGrid:
    "grid grid-cols-[minmax(0,_1.35fr)_minmax(19rem,_0.65fr)] items-start gap-ui-5 max-[72rem]:grid-cols-1",
  primaryColumn: "flex min-w-0 flex-col gap-ui-5",
  secondaryColumn:
    "flex min-w-0 flex-col gap-ui-5 sticky top-[calc(64px_+_var(--arbor-space-4))] max-[72rem]:static",
  section: "flex flex-col gap-ui-3",
  sectionTitle: "m-0 font-sans text-title [font-weight:680] text-foreground",
  stack: "flex flex-col gap-ui-3",
  note: "m-0 text-small text-muted-foreground",
  renameLabel:
    "grid gap-ui-1 text-muted-foreground text-small [&_input]:min-h-[var(--arbor-row-height)] [&_input]:border [&_input]:border-solid [&_input]:border-border [&_input]:rounded-sm [&_input]:p-[0_var(--arbor-space-2)] [&_input]:bg-card [&_input]:text-foreground [&_input]:font-sans",
  confirmPanel:
    "flex flex-col gap-ui-2 p-ui-3 border border-solid border-destructive rounded-md bg-card text-muted-foreground text-small [&_strong]:text-foreground",
  confirmActions: "flex flex-wrap gap-ui-2",
  preferences:
    "flex flex-wrap items-end gap-ui-4 max-[48rem]:items-stretch max-[48rem]:flex-col max-[48rem]:gap-ui-3",
  preferenceGroup:
    "flex flex-wrap gap-ui-3 min-w-0 m-0 p-0 border-0 [&_legend]:mb-ui-2 [&_legend]:text-muted-foreground [&_legend]:text-small [&_label]:inline-flex [&_label]:items-center [&_label]:gap-ui-1 [&_label]:text-foreground",
  rangePreference:
    "grid grid-cols-[minmax(0,_1fr)_auto] items-center gap-ui-2 min-w-[min(100%,_16rem)] text-foreground text-small [&_input]:[grid-column:1_/_-1] [&_input]:w-full [&_input]:accent-primary [&_span]:text-muted-foreground [&_span]:font-mono",
} as const;
export default styles;
