import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles.css";

// Surface renderer crashes into the main-process log file (bug reports in one place).
window.addEventListener("error", (e) => window.piwork?.log(`window.error: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => window.piwork?.log(`unhandledrejection: ${String((e as PromiseRejectionEvent).reason)}`));
window.piwork?.log("renderer booted");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
