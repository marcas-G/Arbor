/** Tailwind utility recipes for this surface; product state stays with its caller. */
const styles = {
  list: "flex flex-col gap-ui-2 m-0",
  pair: "grid grid-cols-[minmax(8rem,_max-content)_1fr] gap-ui-3 items-baseline max-[40rem]:grid-cols-1 max-[40rem]:gap-ui-1",
  term: "text-muted-foreground text-small",
  value: "m-0 min-w-0 wrap-anywhere text-small",
} as const;
export default styles;
