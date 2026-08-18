// PM2 config for PROD servers. Lives at /opt/advance-clearance/ecosystem.config.cjs
// (copied there once during initial setup, not part of each release, so this
// committed copy is a template, not a live mirror - always check the actual
// file on the box before assuming it matches this).
// Paths point at the "current" symlink, which remote-deploy.sh repoints at
// the latest release on every deploy; `pm2 reload` then picks up the change.
//
// PROD1 and PROD2 have DIVERGED from this file and from each other: PROD1
// (10.3.10.49) actually runs `serve` on port 5175, not 5174, because its
// host nginx already occupies 5174 as an inner proxy layer in front of it
// (see deploy/README.md step 7 - PROD1 runs Kubernetes, which complicates
// things). Confirm the live args on each node with `pm2 jlist` before
// editing this port.
module.exports = {
  apps: [
    {
      name: "advance-backend-v2",
      cwd: "/opt/advance-clearance/current/backend",
      script: "dist/src/index.js",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "advance-frontend",
      cwd: "/opt/advance-clearance/current/frontend",
      // Absolute path, not "serve" - pm2 special-cases the bare string "serve"
      // as its own built-in static-file server (`pm2 serve`), which has
      // different (and incompatible) argv parsing from the actual npm
      // package's CLI.
      script: "/usr/lib/node_modules/serve/build/main.js",
      // NOTE: don't add "-l tcp://127.0.0.1:5174" here to restrict this to
      // loopback - the installed `serve` version mis-parses that URI form
      // and crash-loops ("getaddrinfo ENOTFOUND -l"), which took prod down
      // on 2026-08-18. Restrict external access to this port via firewall
      // instead (see deploy/README.md step 7) until a working `serve`
      // syntax is confirmed against the actual PROD binary.
      args: ["-s", "dist", "-l", "5174"],
      env: {
        NODE_ENV: "production"
      }
      
    }
  ]
};
