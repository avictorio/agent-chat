import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RootFallback } from "./RootFallback";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import "../styles.css";

// The note for AI agents a room page carries outside #root (worker/routes/
// pages.ts): text extractors read it; people never need it once the app runs.
document.getElementById("agent-note")?.remove();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root");
createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary label="the page" fallback={<RootFallback />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
