// PM2 config for PROD servers. Lives at /opt/advance-clearance/ecosystem.config.cjs
// (copied there once during initial setup, not part of each release).
// Paths point at the "current" symlink, which remote-deploy.sh repoints at
// the latest release on every deploy; `pm2 reload` then picks up the change.
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
      // Loopback only - the public entry point is the load balancer
      // (https://flowdesk.etl.co.ls) -> nginx -> here, not this port directly.
      args: ["-s", "dist", "-l", "tcp://127.0.0.1:5174"],
      env: {
        NODE_ENV: "production"
      }
      
    }
  ]
};
