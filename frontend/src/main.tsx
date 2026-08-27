import React from "react";
import ReactDOM from "react-dom/client";
import "sweetalert2/dist/sweetalert2.min.css";
import { showNotice } from "./alerts";
import "./styles.css";
import App from "./App";
import { startVersionCheck } from "./versionCheck";

window.alert = (message?: string) => {
  void showNotice(String(message ?? ""));
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

startVersionCheck();
