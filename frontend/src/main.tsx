import React from "react";
import ReactDOM from "react-dom/client";
import "sweetalert2/dist/sweetalert2.min.css";
import { showNotice } from "./alerts";
import "./styles.css";
import App from "./App";
import { startVersionCheck } from "./versionCheck";
import { API } from "./api";

// Verification links printed on signed PDFs (/signatures/verify/<code>) are
// answered by the backend. Where the API lives under a prefix (PROD: /api),
// those paths reach this app instead - forward them to the backend.
const forwardingToVerify = window.location.pathname.startsWith("/signatures/verify") && API.startsWith("/");
if (forwardingToVerify) window.location.replace(`${API}${window.location.pathname}${window.location.search}`);

window.alert = (message?: string) => {
  void showNotice(String(message ?? ""));
};

if (!forwardingToVerify) {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
  startVersionCheck();
}
