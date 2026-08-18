# CI/CD setup runbook

This describes the one-time manual setup required for `.gitlab-ci.yml` to
build, test, and deploy this app to PROD1 and PROD2 (active-active behind a
load balancer) on every merge to `main`. None of these steps are run by CI
itself.

## 1. Register a GitLab Runner (build/test/package)

On this UAT host:

```bash
curl -L https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh | sudo bash
sudo apt-get install gitlab-runner
sudo gitlab-runner register \
  --url http://10.3.10.48:4040 \
  --executor shell \
  --tag-list build \
  --description "advance-clearance build runner"
```

Use a registration token from the project's GitLab Settings → CI/CD →
Runners. The runner needs Node 22 (`node -v` on this host already reports
v22.20.0) and `npm` available to the `gitlab-runner` user.

## 2. SSH deploy key

```bash
ssh-keygen -t ed25519 -f deploy_key -C "advance-clearance-ci" -N ""
```

- Add `deploy_key` (private key contents) as a GitLab CI/CD variable named
  `SSH_PRIVATE_KEY` — mark it **Protected** and **Masked**, type "File" or
  raw text (the pipeline does `echo "$SSH_PRIVATE_KEY" | ssh-add -`).
- Append `deploy_key.pub` to `~/.ssh/authorized_keys` for the deploy user on
  **both** PROD1 and PROD2.

## 3. GitLab CI/CD variables

Project Settings → CI/CD → Variables, add (Protected, restricted to `main`):

| Variable     | Example value     | Notes                              |
|--------------|--------------------|------------------------------------|
| `SSH_PRIVATE_KEY` | (key contents) | from step 2 |
| `DEPLOY_USER`     | `deploy`       | SSH user on PROD1/PROD2 |
| `PROD1_HOST`      | `10.x.x.11`    | PROD server 1 |
| `PROD2_HOST`      | `10.x.x.12`    | PROD server 2 |

## 4. Prepare each PROD server (PROD1 and PROD2)

```bash
# Node 22, matching this UAT host
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs

# Process manager + static file server
sudo npm install -g pm2 serve

# App directory layout
sudo mkdir -p /opt/advance-clearance/releases
sudo chown -R deploy:deploy /opt/advance-clearance

# Production secrets (NOT in git) - copy from backend-v2/.env.example and fill in
sudo mkdir -p /etc/advance-clearance
sudo $EDITOR /etc/advance-clearance/.env
```

`/etc/advance-clearance/.env` should mirror `backend-v2/.env.example` but with
production values, in particular:
- `DATABASE_URL` pointing at the shared PROD Postgres (see step 5)
- `CORS_ORIGIN` / `APP_URL` set to `https://flowdesk.etl.co.ls` (the public
  load-balancer URL - see step 7; no port, TLS terminates at the LB)
- `NODE_ENV=production`

## 5. Shared PROD database

Both PROD servers must point at the **same** Postgres instance (the
per-developer `docker-compose.yml` Postgres is UAT-only). Provision a
Postgres 16 instance reachable from both PROD servers and load the schema
once:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

## 6. First deploy (bootstrap)

The first deploy can't `pm2 reload` an app that doesn't exist yet. On each
PROD server, after copying `deploy/ecosystem.config.cjs` to
`/opt/advance-clearance/ecosystem.config.cjs` and running the first
`remote-deploy.sh` manually (so `/opt/advance-clearance/current` exists):

```bash
pm2 start /opt/advance-clearance/ecosystem.config.cjs
pm2 save
```

After this, every CI deploy on `main` runs `pm2 reload ...`, which picks up
the new code via the repointed `current` symlink with zero downtime.

## 7. nginx + load balancer

On each PROD server, copy `deploy/nginx-advance-clearance.conf.example` to
`/etc/nginx/sites-available/advance-clearance`, adjust as needed, symlink
into `sites-enabled`, and `nginx -s reload`. Point the load balancer's plain
HTTP backend pool at port 80 on both PROD1 and PROD2.

TLS terminates at the load balancer: it holds the certificate for
`flowdesk.etl.co.ls`, listens on 443, and forwards decrypted HTTP to the
port-80 pool above (`X-Forwarded-Proto` is already forwarded by the nginx
vhost, so the app sees the request as HTTPS). This is what makes
`https://flowdesk.etl.co.ls` - no port - the intended public URL. `serve`
itself still listens on all interfaces on 5174 (binding it to loopback
crash-loops the installed `serve` version - see the note in
`deploy/ecosystem.config.cjs`), so **firewall port 5174, same as port 4000
(backend), on both PROD nodes to the LB and the email-action external proxy
host only** - see step 8 - not the open internet. Without that firewall
rule, the direct `flowdesk.etl.co.ls:5174` link still works and bypasses the
LB/TLS entirely.

Note: the frontend is built with `VITE_API=/api`, so it calls
`/api/<route>` (e.g. `/api/auth/login`); the nginx config proxies `/api/` to
the backend with the prefix stripped, matching the backend's root-level
routes (`/auth`, `/advances`, etc.).

## 8. (Optional) Email-action proxy

If approvers need to act on "Approve or Reject by Email" links from a
network that can't reach the app directly, add the **active** location block
from `deploy/nginx-email-action-proxy.conf.example` — PROD, external,
`dt-externalproxy-1.etl.co.ls/etl/flowdesk/prod/email-actions/` — to that
proxy's server block. It forwards *only* to the backend's `/email-actions`
route, directly on its port — not through the general `/flowdesk/prod/` app
proxy block that already exists there, since that routes to the frontend for
anything outside `/api/` and `emailActionsRouter` is mounted at the
backend's root, not under `/api/`. The backend renders a self-contained
HTML confirmation page for browser requests (see `email-actions.routes.ts`),
so no frontend proxying or `/api/`/`/assets/` forwarding is needed either
way.

This block round-robins directly between PROD1 (`10.3.10.49`) and PROD2
(`10.3.10.69`), bypassing the load balancer, since either instance can
redeem a token via the shared DB. Port `4000` is assumed to match UAT's
default — confirm it on the actual PROD hosts before relying on it.

The example file also has two **inactive** (commented-out) blocks kept as
reference/fallback, not part of the normal rollout:
- UAT (`dt-internalproxy-1.etl.co.ls/flowdesk/uat/email-actions/`) — UAT is
  a sandbox, not what gets shipped to prod.
- PROD, internal (`dt-internalproxy-1.etl.co.ls/flowdesk/prod/email-actions/`)
  — intranet-only; confirmed reachable and working as of this writing, but
  superseded by the external block, since intranet approvers can still reach
  an externally-hosted link but the reverse isn't true.

Once the external block is live, set
`EMAIL_ACTION_PUBLIC_URL=https://dt-externalproxy-1.etl.co.ls/etl/flowdesk/prod`
(no trailing slash) in `/etc/advance-clearance/.env` on **both** PROD1 and
PROD2 so generated email links point there instead of the internal
`APP_URL`. Leave it unset if this isn't needed — email links then fall back
to `APP_URL` and only work from inside the network via the SPA.
