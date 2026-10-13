import { DEFAULT_ECONET_LOGO_DATA_URI } from "./pdf/assets/econetLogo.js";

// Shared shell for the small set of self-contained, unauthenticated HTML
// pages this API serves directly (signature verification, email approval
// links) - same CSP-driven constraints apply to all of them: no external
// CSS/JS/fonts, everything inlined so the page renders correctly behind any
// reverse-proxy path prefix and inside any email client's webview.
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

const SHARED_CSS = `
  :root{
    --ink:#161b2e; --muted:#667085;
    --paper-1:#eef1f7; --paper-2:#e1e6f0; --surface:#ffffff; --border:#e3e7f0;
    --accent:#c8102e; --accent-dark:#8f0c1f;
    --good:#0f9d58; --good-soft:#e8f8ee; --good-border:#bfe6cf;
    --bad:#dc2626; --bad-soft:#fdecec; --bad-border:#f3c6c2;
    --focus:#2f5fdb;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0; padding:40px 16px; min-height:100vh;
    background:linear-gradient(180deg,var(--paper-1) 0%,var(--paper-2) 100%);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    color:var(--ink); display:flex; justify-content:center;
  }
  .wrap{width:100%; max-width:460px}
  .brand{display:flex; align-items:center; justify-content:center; gap:10px; margin-bottom:22px}
  .brand img{height:32px; width:auto; display:block}
  .brand-name{font-size:14px; font-weight:700; letter-spacing:.3px; color:var(--ink)}
  .card{background:var(--surface); border:1px solid var(--border); border-radius:16px; overflow:hidden; box-shadow:0 1px 2px rgba(16,24,40,.04), 0 12px 28px rgba(16,24,40,.08)}
  .card-accent{height:4px; background:linear-gradient(90deg,var(--accent),var(--accent-dark))}
  .card-body{padding:28px 26px}
  h1{font-size:19px; margin:0 0 8px; font-weight:700; line-height:1.3}
  p.lead{margin:0 0 22px; color:var(--muted); font-size:13.5px; line-height:1.55}
  .foot{text-align:center; margin-top:20px; font-size:11.5px; color:var(--muted); letter-spacing:.2px}

  .search{display:flex; gap:8px; margin-bottom:4px}
  .search input{flex:1; min-width:0; padding:11px 12px; border:1px solid var(--border); border-radius:10px; font-size:15px; text-transform:uppercase; letter-spacing:.5px; background:var(--paper-1); color:var(--ink)}
  .search input:focus{outline:2px solid var(--focus); outline-offset:1px}
  .search button{padding:11px 18px; border:none; border-radius:10px; background:var(--accent); color:#fff; font-size:14px; font-weight:600; cursor:pointer}
  .search button:hover{background:var(--accent-dark)}

  .result{border-radius:12px; margin-top:20px; border:1px solid; overflow:hidden}
  .result.good{background:var(--good-soft); border-color:var(--good-border)}
  .result.bad{background:var(--bad-soft); border-color:var(--bad-border)}
  .result-head{display:flex; align-items:center; gap:8px; padding:12px 16px 10px; font-size:12.5px; font-weight:700; letter-spacing:.3px; text-transform:uppercase}
  .result.good .result-head{color:var(--good)}
  .result.bad .result-head{color:var(--bad)}
  .dot{width:8px; height:8px; border-radius:50%; background:currentColor; flex:none}
  .rows{padding:2px 16px 14px}
  .rows p.msg{margin:0; padding:6px 0; font-size:13.5px; color:var(--ink)}
  .row{display:flex; justify-content:space-between; gap:12px; padding:6px 0; font-size:13.5px; border-top:1px solid rgba(0,0,0,.05)}
  .row:first-child{border-top:none}
  .row span:first-child{color:var(--muted)}
  .row strong{text-align:right; font-weight:600}

  .summary{border:1px solid var(--border); border-radius:12px; padding:14px 16px; margin:18px 0 20px; background:var(--paper-1)}
  .summary .doc{font-size:15px; font-weight:700; margin-bottom:8px}
  .summary .kv{display:flex; justify-content:space-between; font-size:13.5px; padding:3px 0; color:var(--muted)}
  .summary .kv strong{color:var(--ink); font-weight:600}
  textarea{width:100%; min-height:76px; margin:0 0 14px; padding:10px 12px; font-family:inherit; font-size:13.5px; box-sizing:border-box; border:1px solid var(--border); border-radius:10px; background:var(--surface); color:var(--ink); resize:vertical}
  textarea:focus{outline:2px solid var(--focus); outline-offset:1px}
  .actions{display:flex; gap:10px}
  .btn{flex:1; padding:12px; border:none; border-radius:10px; font-size:14.5px; font-weight:600; cursor:pointer; color:#fff}
  .btn:disabled{opacity:.6; cursor:default}
  .approve{background:var(--good)}
  .approve:hover:not(:disabled){background:#0c7f47}
  .reject{background:var(--bad)}
  .reject:hover:not(:disabled){background:#b91c1c}
  .status{margin-top:4px; font-weight:600; font-size:14px; padding:14px 16px; border-radius:10px; background:var(--paper-1); border:1px solid var(--border)}
`;

export function renderBrandedPage(opts: { title: string; bodyHtml: string }): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.title}</title>
<style>${SHARED_CSS}</style></head>
<body>
  <div class="wrap">
    <div class="brand"><img src="${DEFAULT_ECONET_LOGO_DATA_URI}" alt="Econet Telecom Lesotho" /><span class="brand-name">FlowDesk</span></div>
    <div class="card"><div class="card-accent"></div><div class="card-body">${opts.bodyHtml}</div></div>
    <p class="foot">Econet Telecom Lesotho &middot; FlowDesk</p>
  </div>
</body></html>`;
}
