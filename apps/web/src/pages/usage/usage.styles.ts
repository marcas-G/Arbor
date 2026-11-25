const styles = {
  page: "w-full min-w-0 flex flex-col gap-ui-4",
  title: "m-0 font-sans text-display font-semibold text-foreground",
  mobileRows: "flex flex-col gap-ui-2 m-0 p-0 list-none",
  mobileRow:
    "min-w-0 p-ui-3 border border-solid border-border rounded-md bg-card",
  rowValues:
    "grid grid-cols-2 gap-ui-2 m-0 [&>_div]:min-w-0 [&_dt]:text-muted-foreground [&_dt]:text-caption [&_dd]:m-0 [&_dd]:wrap-anywhere max-[24rem]:grid-cols-1",
} as const;
export default styles;
