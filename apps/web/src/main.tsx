import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/reset.css";
import "./tokens.css";
import "./components/components.css";
import "./views/views.css";
import "./problems/problems.css";
import "./session/session.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("root element missing");
}
createRoot(root).render(<App />);
