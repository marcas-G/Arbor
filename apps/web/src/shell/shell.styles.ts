/** Tailwind utility recipes for this surface; product state stays with its caller. */
const styles = {
  shell:
    "flex min-h-screen bg-background text-foreground max-[47.99rem]:flex-col",
  rail: "sticky top-0 hidden w-[264px] h-screen flex-none flex-col gap-ui-4 p-[var(--arbor-space-4)_var(--arbor-space-3)] border-r border-solid border-rail-line bg-rail text-rail-ink max-[63.99rem]:w-[224px] min-[768px]:flex",
  brandBlock:
    "flex items-center gap-ui-3 p-[var(--arbor-space-1)_var(--arbor-space-2)_var(--arbor-space-2)]",
  brandMark:
    "grid w-[38px] h-[38px] flex-none place-items-center border border-solid border-rail-line rounded-[11px] bg-rail-raised text-rail-ink",
  brandCopy: "grid min-w-0 gap-[1px]",
  brand: "text-title [font-weight:760] tracking-[-0.02em]",
  brandTagline:
    "overflow-hidden text-rail-muted text-caption text-ellipsis whitespace-nowrap",
  projectSwitch:
    "grid w-full grid-cols-[auto_minmax(0,_1fr)_auto] items-center gap-ui-2 p-ui-2 border border-solid border-rail-line rounded-md bg-rail-raised text-rail-ink cursor-pointer text-left [transition:border-color_140ms_ease,_transform_140ms_ease] [&:hover]:border-[color-mix(in_srgb,_var(--arbor-rail-ink)_34%,_transparent)] [&:hover]:[transform:translateY(-1px)]",
  projectGlyph:
    "grid w-[32px] h-[32px] place-items-center rounded-sm bg-[color-mix(in_srgb,_var(--arbor-leaf-bright)_24%,_transparent)] text-rail-ink",
  projectCopy: "grid min-w-0 gap-[2px]",
  projectLabel: "text-rail-muted text-caption",
  projectName:
    "overflow-hidden text-small [font-weight:650] text-ellipsis whitespace-nowrap",
  projectChevron: "text-rail-muted [transition:transform_140ms_ease]",
  projectPanel: "grid gap-ui-3",
  projectPanelCreate: "grid gap-ui-3",
  projectPanelCreateButton:
    "flex min-h-[64px] items-center gap-ui-3 p-ui-3 border border-solid border-[color-mix(in_srgb,_var(--arbor-leaf)_38%,_transparent)] rounded-md bg-accent text-primary cursor-pointer font-sans text-left [&>_span]:grid [&>_span]:gap-[2px] [&_small]:text-muted-foreground [&_small]:text-caption [&_small]:font-normal",
  projectPanelBack:
    "justify-self-start p-[var(--arbor-space-1)_0] border-0 bg-transparent text-primary cursor-pointer font-sans text-small",
  navSection: "grid gap-ui-2",
  navCaption:
    "p-[0_var(--arbor-space-2)] text-rail-muted text-caption font-bold tracking-[0.1em]",
  navList: "flex flex-col gap-[3px]",
  navItem:
    "flex min-h-[48px] items-center gap-ui-3 p-[var(--arbor-space-2)_var(--arbor-space-3)] border border-solid border-[transparent] rounded-sm bg-transparent text-rail-muted cursor-pointer font-sans text-left [transition:background_140ms_ease,_color_140ms_ease] [&:hover]:bg-[color-mix(in_srgb,_var(--arbor-rail-ink)_6%,_transparent)] [&:hover]:text-rail-ink [&:disabled]:cursor-default [&:disabled]:opacity-[0.45]",
  navItemActive:
    "aria-[current=page]:border-rail-line aria-[current=page]:bg-rail-raised aria-[current=page]:text-rail-ink border-rail-line bg-rail-raised text-rail-ink [box-shadow:inset_3px_0_0_var(--arbor-leaf-bright)]",
  navItemCopy:
    "grid gap-[1px] [&>_span]:text-body [&>_span]:[font-weight:580] [&_small]:text-[inherit] [&_small]:text-caption [&_small]:opacity-[0.72]",
  sessionBlock:
    "grid grid-cols-[auto_minmax(0,_1fr)_auto] items-center gap-ui-2 mt-auto p-ui-2 border-t border-solid border-rail-line",
  avatar:
    "grid w-[32px] h-[32px] place-items-center rounded-full bg-[color-mix(in_srgb,_var(--arbor-leaf-bright)_26%,_transparent)] text-rail-ink text-small font-bold",
  sessionCopy: "grid min-w-0 gap-[1px]",
  sessionLabel: "text-rail-ink text-small font-semibold",
  sessionActor:
    "overflow-hidden text-rail-muted text-caption text-ellipsis whitespace-nowrap",
  disconnect:
    "grid w-[32px] h-[32px] place-items-center border-0 rounded-sm bg-transparent text-rail-muted cursor-pointer [&:hover]:bg-rail-raised [&:hover]:text-rail-ink",
  main: "flex min-w-0 flex-1 flex-col",
  topbar:
    "sticky top-0 z-[12] flex min-w-0 min-h-[64px] items-center justify-between gap-ui-3 p-[var(--arbor-space-2)_var(--arbor-space-5)] border-b border-solid border-border bg-[color-mix(in_srgb,_var(--arbor-paper-2)_92%,_transparent)] [backdrop-filter:blur(14px)] max-[63.99rem]:px-ui-3 max-[47.99rem]:min-h-[52px]",
  breadcrumb:
    "flex min-w-0 items-center gap-ui-2 overflow-hidden text-small whitespace-nowrap [&_strong]:text-foreground [&_strong]:[font-weight:650]",
  breadcrumbProject:
    "inline-flex items-center gap-ui-1 overflow-hidden p-0 border-0 bg-transparent text-muted-foreground cursor-pointer font-sans text-ellipsis",
  breadcrumbSeparator: "text-border-strong max-[47.99rem]:hidden",
  topbarStatus:
    "flex flex-none items-center gap-ui-2 max-[47.99rem]:[&>_:first-child]:hidden",
  content:
    "flex min-w-0 min-h-0 flex-1 p-ui-5 overflow-x-clip max-[63.99rem]:p-ui-3 max-[47.99rem]:pb-[calc(var(--arbor-space-3)+4rem+env(safe-area-inset-bottom))]",
  tabbar:
    "sticky bottom-0 z-[20] flex border-t border-solid border-border bg-[color-mix(in_srgb,_var(--arbor-paper-2)_94%,_transparent)] [backdrop-filter:blur(14px)] min-[768px]:hidden pb-[env(safe-area-inset-bottom)]",
  tabItem:
    "flex flex-1 flex-col items-center gap-[2px] p-[var(--arbor-space-2)_0] border-0 bg-transparent text-subtle cursor-pointer font-sans text-caption",
  tabItemActive:
    "aria-[current=page]:text-primary text-primary [font-weight:650] [box-shadow:inset_0_2px_0_var(--arbor-leaf)]",
} as const;
export default styles;
