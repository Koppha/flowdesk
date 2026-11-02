import express, { Router } from "express";
import path from "path";

// FlowDesk Mobile's "Sign a document" screens (mobile-web/ in this repo),
// which the app opens in a WebView - so changing them is a server deploy,
// never an app release. The page is static and holds no data: every API call
// it makes carries the user's own Bearer token, so it's served without
// requireAuth and must be mounted BEFORE mobileAppRouter in app.ts (that
// router applies requireAuth to everything under /mobile-app).
//
// MOBILE_WEB_DIR overrides where the built page lives (a release layout
// without the repo's sibling mobile-web/ folder).
const pageDir = process.env.MOBILE_WEB_DIR || path.resolve(process.cwd(), "../mobile-web/dist");

export const mobileSignPageRouter = Router();

// Asset URLs in the page are relative ("./assets/..."), so it must be loaded
// with a trailing slash. express.static's own slash redirect is absolute
// ("/mobile-app/web/") and would drop a reverse-proxy prefix like
// /etl/flowdesk/uat - redirect relatively instead. Mounted at both
// /mobile-app/web (Sign a Document and Maintenance) and the original
// /mobile-app/sign, so the redirect uses whichever was asked for.
mobileSignPageRouter.get("/", (req, res, next) => {
  const pathname = req.originalUrl.split("?")[0];
  if (!pathname.endsWith("/")) {
    const query = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    return res.redirect(301, `${pathname.slice(pathname.lastIndexOf("/") + 1)}/${query}`);
  }
  return next();
});

mobileSignPageRouter.use(
  express.static(pageDir, {
    index: "index.html",
    redirect: false,
    setHeaders: (res, filePath) => {
      // pdf.js's worker is an ES module (.mjs), which the browser refuses
      // unless it's served as JavaScript (helmet sets nosniff).
      if (filePath.endsWith(".mjs")) res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      // Vite fingerprints everything under assets/, so those can be cached
      // for good; index.html must always be re-checked to pick up a deploy.
      res.setHeader("Cache-Control", filePath.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
    }
  })
);
