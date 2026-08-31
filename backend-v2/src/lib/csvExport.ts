import type { Response } from "express";

// Shared CSV export helper - none existed before the Treasury reports
// (every older Report*.tsx hand-rolls this inline, client-side, from
// whatever's already loaded in the browser). These reports instead filter
// server-side and can export directly from the same query result, so the
// export always matches the active on-screen filters exactly.
export function sendCsv(res: Response, filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}
