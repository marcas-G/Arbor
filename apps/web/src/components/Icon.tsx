import {
  Activity,
  ChartNoAxesColumn,
  ChevronRight,
  LayoutDashboard,
  Leaf,
  ListTodo,
  LogOut,
  type LucideProps,
  MessageCircle,
  Network,
  Settings,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
export type IconName =
  | "activity"
  | "attention"
  | "chevron"
  | "conversation"
  | "disconnect"
  | "leaf"
  | "queue"
  | "settings"
  | "spark"
  | "tree"
  | "usage"
  | "workbench";

const icons = {
  activity: Activity,
  attention: TriangleAlert,
  chevron: ChevronRight,
  conversation: MessageCircle,
  disconnect: LogOut,
  leaf: Leaf,
  queue: ListTodo,
  settings: Settings,
  spark: Sparkles,
  tree: Network,
  usage: ChartNoAxesColumn,
  workbench: LayoutDashboard,
} as const;

export function Icon({
  name,
  size = 18,
  ...props
}: { readonly name: IconName; readonly size?: number } & Omit<
  LucideProps,
  "children"
>) {
  const Glyph = icons[name];
  return <Glyph aria-hidden="true" size={size} strokeWidth={1.8} {...props} />;
}
