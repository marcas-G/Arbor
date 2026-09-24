import { useEffect, useState } from "react";

/** Tracks the product's compact layout breakpoint without storing UI in URLs. */
export function useCompactLayout(breakpoint = 1024): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && window.innerWidth < breakpoint,
  );

  useEffect(() => {
    const update = (): void => {
      setCompact(window.innerWidth < breakpoint);
    };
    window.addEventListener("resize", update);
    update();
    return () => window.removeEventListener("resize", update);
  }, [breakpoint]);

  return compact;
}
