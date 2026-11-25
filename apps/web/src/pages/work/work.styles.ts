/** Tailwind utility recipes for this surface; product state stays with its caller. */
const styles = {
  page: "w-full min-w-0 flex flex-col gap-ui-3",
  header:
    "flex flex-wrap justify-between gap-ui-4 p-ui-4 border border-solid border-border rounded-md bg-card max-[63.99rem]:flex-col max-[63.99rem]:items-stretch max-[63.99rem]:p-ui-3",
  headerMain: "flex flex-1 flex-col items-start gap-ui-2 min-w-0",
  idLine: "flex flex-wrap items-center gap-ui-2",
  governance: "flex flex-col items-end gap-ui-1 max-[63.99rem]:items-stretch",
  governanceCaption: "text-caption text-subtle",
  governanceActions: "flex flex-wrap gap-ui-2 max-[63.99rem]:[&>_*]:flex-1",
} as const;
export default styles;
