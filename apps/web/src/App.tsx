/**
 * P13 `01`: the Arbor web client is a Projection Renderer + Command
 * Initiator. P13-003 demo: token-driven Card + Badge proof (layout is
 * rewritten by P13-004).
 */
import { Badge } from "./components/Badge.js";
import { Card } from "./components/Card.js";
import "./components/components.css";

export function App() {
  return (
    <div className="arbor-app">
      <header className="arbor-topbar">
        <span className="arbor-brand">Arbor</span>
      </header>
      <main aria-label="arbor-main" className="arbor-main">
        <Card title="Design tokens">
          <div className="arbor-badge-row">
            <Badge tone="leaf">executing</Badge>
            <Badge tone="attention">pending</Badge>
            <Badge tone="danger">waiting-blocked</Badge>
            <Badge tone="muted">retired</Badge>
            <Badge tone="branch">workspace-detail</Badge>
            <Badge tone="sky">info</Badge>
          </div>
        </Card>
      </main>
    </div>
  );
}
