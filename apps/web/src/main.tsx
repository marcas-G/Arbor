import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./tokens.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("root element missing");
}
createRoot(root).render(<App />);
