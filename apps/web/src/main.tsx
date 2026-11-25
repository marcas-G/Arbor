import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/reset.css";
import "./tokens.css";
import "./styles/tailwind.css";
import "./styles/accessibility.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("root element missing");
}
createRoot(root).render(<App />);
