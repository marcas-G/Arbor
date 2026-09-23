/**
 * P13-004 app shell: topbar brand + empty main ("选择项目"). Data fetching,
 * routing and command wiring land in later P13 tasks — this pass owns the
 * view/problem render layer only.
 */
import { Empty } from "./components/Empty.js";
import "./components/components.css";
import "./views/views.css";
import "./problems/problems.css";

export function App() {
  return (
    <div className="arbor-app">
      <header className="arbor-topbar">
        <span className="arbor-brand">Arbor</span>
      </header>
      <main aria-label="arbor-main" className="arbor-main">
        <Empty>选择项目</Empty>
      </main>
    </div>
  );
}
