import React from "react";
import { createRoot } from "react-dom/client";
import BubbleApp from "./BubbleApp";
import "./bubble.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BubbleApp />
  </React.StrictMode>,
);
