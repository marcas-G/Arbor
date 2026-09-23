/**
 * P13 `01`: the Arbor web client is a Projection Renderer + Command
 * Initiator. This root component grows through P13-003..P13-007; the
 * skeleton renders the shell only.
 */
export function App() {
  return (
    <div className="arbor-app">
      <header className="arbor-topbar">
        <span className="arbor-brand">Arbor</span>
      </header>
      <main aria-label="arbor-main" />
    </div>
  );
}
