import type { ReactNode } from "react";
import {
  TabsContent,
  TabsList,
  TabsTrigger,
  Tabs as UiTabs,
} from "./ui/tabs.js";

export type TabItem = {
  readonly key: string;
  readonly label: string;
};

/** Selection remains route-owned. Arrow keys move focus; Enter selects. */
export function Tabs({
  items,
  active,
  onChange,
  children,
}: {
  readonly items: ReadonlyArray<TabItem>;
  readonly active: string;
  readonly onChange: (key: string) => void;
  readonly children?: ReactNode;
}) {
  return (
    <UiTabs value={active} onValueChange={onChange} activationMode="manual">
      <TabsList>
        {items.map((item) => (
          <TabsTrigger key={item.key} value={item.key}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {children === undefined ? null : (
        <TabsContent value={active}>{children}</TabsContent>
      )}
    </UiTabs>
  );
}
