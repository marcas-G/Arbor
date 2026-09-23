/**
 * Top-level render-crash boundary: an unexpected client error degrades to an
 * explicit error card instead of a blank page (presentation-only; the server
 * remains the sole authority — the boundary never recovers business state,
 * it only offers a full reload).
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

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
        <div className="arbor-error-boundary">
          <section className="arbor-card">
            <header className="arbor-card-header">
              <h2 className="arbor-card-title">界面渲染出错</h2>
            </header>
            <div className="arbor-card-body">
              <p className="arbor-mono">{this.state.message}</p>
              <button
                type="button"
                className="arbor-button arbor-button-primary"
                onClick={() => {
                  location.reload();
                }}
              >
                重新加载
              </button>
            </div>
          </section>
        </div>
      );
    }
    return this.props.children;
  }
}
