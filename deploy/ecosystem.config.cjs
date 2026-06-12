// PM2 config for PROD servers. Lives at /opt/advance-clearance/ecosystem.config.cjs
// (copied there once during initial setup, not part of each release).
// Paths point at the "current" symlink, which remote-deploy.sh repoints at
// the latest release on every deploy; `pm2 reload` then picks up the change.
module.exports = {
  apps: [
    {
      name: "advance-backend-v2",
      cwd: "/opt/advance-clearance/current/backend",
      script: "dist/index.js",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "advance-frontend",
      cwd: "/opt/advance-clearance/current/frontend",
      script: "serve",
      args: "-s dist -l 5174",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
