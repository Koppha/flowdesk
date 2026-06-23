import React from "react";
import ReactDOM from "react-dom/client";
import "sweetalert2/dist/sweetalert2.min.css";
import { showNotice } from "./alerts";
import "./styles.css";
import App from "./App";

window.alert = (message?: string) => {
  void showNotice(String(message ?? ""));
};

// Prevent any button from being clicked twice within 600ms.
// Buttons that manage their own async state (disabled/busy) are already
// blocked by React; this covers everything else globally at the DOM level.
document.addEventListener("click", (e) => {
  const btn = (e.target as Element).closest("button:not([disabled])");
  if (!btn) return;
  btn.setAttribute("data-clicked", "true");
  setTimeout(() => btn.removeAttribute("data-clicked"), 600);
}, false);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
