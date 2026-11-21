import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RootFallback } from "./RootFallback";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import "../styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root");
createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary label="the page" fallback={<RootFallback />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
