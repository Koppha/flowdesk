import React from "react";
import ReactDOM from "react-dom/client";
import Swal from "sweetalert2";
import "./styles.css";
import App from "./App";

window.alert = (message?: string) => {
  Swal.fire({
    icon: "info",
    title: "Notice",
    text: String(message ?? ""),
    confirmButtonText: "OK"
  });
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
