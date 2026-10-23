# FlowDesk mobile signing page

The "Sign a document" screens for the FlowDesk mobile app. The app opens this
page in a WebView, so changing it is a server deploy - no app release.

- Served by backend-v2 at `<api>/mobile-app/sign/` (static, before the
  router's `requireAuth`; see `backend-v2/src/app.ts`). Every API call goes
  back to the same `<api>` prefix with the user's Bearer token.
- The app injects `window.__FLOWDESK__ = { token, theme, docId? }` before the
  page loads and listens for `window.ReactNativeWebView.postMessage` events
  (`close`, `signed`, `sessionExpired`). Opened in a normal browser, the page
  shows its own sign-in form instead (handy for testing).

## Build and deploy (UAT)

```bash
cd mobile-web
npm ci
npm run build          # -> mobile-web/dist, served as-is by the backend
```

No backend restart is needed for page changes - only for the one-time
`app.ts` mount.
