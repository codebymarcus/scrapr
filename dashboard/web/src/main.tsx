import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.scss";

// Placeholder shell; the real app tree is wired in a later task.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main>
      <h1>Scrapr</h1>
    </main>
  </StrictMode>,
);
