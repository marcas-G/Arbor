/**
 * Top-level render-crash boundary: an unexpected client error degrades to an
 * explicit error card instead of a blank page (presentation-only; the server
 * remains the sole authority — the boundary never recovers business state,
 * it only offers a full reload).
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { cn } from "./lib/utils.js";

export class ErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly message: string | null }
> {
  override state: { readonly message: string | null } = { message: null };

  static getDerivedStateFromError(error: unknown): {
    readonly message: string;
  } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("arbor render error", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.message !== null) {
      return (
        <div
          className={cn("arbor-error-boundary", "p-ui-4 flex justify-center")}
        >
          <section
            className={cn(
              "arbor-card",
              "bg-card border border-solid border-border rounded-md shadow-card overflow-hidden",
            )}
          >
            <header
              className={cn(
                "arbor-card-header",
                "p-[var(--arbor-space-3)_var(--arbor-space-4)] border-b border-solid border-border bg-[color-mix(in_srgb,_var(--arbor-paper)_44%,_transparent)]",
              )}
            >
              <h2
                className={cn(
                  "arbor-card-title",
                  "m-0 text-foreground text-title [font-weight:680] tracking-[-0.01em]",
                )}
              >
                页面暂时无法显示
              </h2>
            </header>
            <div className={cn("arbor-card-body", "p-ui-4")}>
              <p>重新加载页面通常可以恢复。未提交的输入可能需要重新填写。</p>
              <details>
                <summary>问题详情</summary>
                <p className={cn("arbor-mono", "font-mono text-small")}>
                  {this.state.message}
                </p>
              </details>
              <button
                type="button"
                className={cn(
                  "arbor-button arbor-button-primary",
                  "min-h-[var(--arbor-row-height)] p-[var(--arbor-space-1)_var(--arbor-space-3)] border border-solid border-border rounded-sm bg-card text-foreground font-sans text-small [font-weight:650] cursor-pointer [transition:border-color_140ms_ease,_background_140ms_ease,_color_140ms_ease,_transform_140ms_ease,_box-shadow_140ms_ease] [&:disabled]:cursor-not-allowed [&:disabled]:opacity-[0.5] border-primary bg-primary text-card [box-shadow:0_4px_12px_color-mix(in_srgb,_var(--arbor-leaf)_20%,_transparent)]",
                )}
                onClick={() => {
                  location.reload();
                }}
              >
                重新加载页面
              </button>
            </div>
          </section>
        </div>
      );
    }
    return this.props.children;
  }
}
