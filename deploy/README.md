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

**There is no separate load balancer.** `flowdesk.etl.co.ls` DNS round-robins
directly to PROD1's and PROD2's own IPs (`10.3.10.49` / `10.3.10.69`) - each
node terminates its own TLS with the same real cert
(`/etc/nginx/ssl/flowdesk.{crt,key}` on each box). This was discovered the
hard way on 2026-08-18 (see `deploy/nginx-advance-clearance.conf.example`'s
header comment for the incident this caused) - the two nodes turned out to
be set up quite differently from each other and from that example file,
which is closer to a starting point than a description of either node.

**PROD2 (`10.3.10.69`) - the simple case:** plain nginx listens on 80 and
443 directly (`server_name 10.3.10.69 flowdesk.etl.co.ls;` in
`/etc/nginx/conf.d/advance-clearance.conf` /
`advance-clearance-ssl.conf`), proxying `/api/` to `127.0.0.1:4000` and `/`
to `127.0.0.1:5174` (where `serve` listens directly - matches
`deploy/ecosystem.config.cjs` as committed).

**PROD1 (`10.3.10.49`) - runs RKE2 (Kubernetes), which changes everything:**
its `rke2-ingress-nginx` controller DNATs ports 80/443 to its own pod
(`iptables -t nat -L`, ports 80/443 → the ingress pod IP) *before* traffic
ever reaches the host nginx. The host nginx here instead listens on 5174
(plain) and 5443 (TLS) - one layer further in - and proxies `/` to
`127.0.0.1:5175`, **not** 5174 (`serve` on this node is bootstrapped to
5175, unlike PROD2's 5174 - the two nodes' `ecosystem.config.cjs` are not
identical; check the live file on each box, don't assume it matches git).
For `https://flowdesk.etl.co.ls` to reach the app on this node at all, a
Kubernetes `Ingress` + `Service` + `Endpoints` + TLS `Secret` (namespace
`default`, see `deploy/k8s-ingress-prod1.yaml.example`) had to be created
pointing at `10.3.10.49:5174` - without it, this node's
ingress just 404s every request, which is exactly what happened on
2026-08-18: DNS sent ~half of requests to a working PROD2 and half to a
PROD1 with no route in, so the site alternated between working and 404 on
every reload until this was applied.

The Endpoints must list **PROD1 only**. PROD2's port 5174 is the bare
`serve` frontend (its `/api/` proxy is in nginx on 443), so including
`10.3.10.69:5174` made the ingress send some API calls there and get
`index.html` back instead of JSON - lists randomly showed as empty/zero for
everyone landing on PROD1. Fixed 2026-10-16 by removing PROD2 from the
Endpoints.

If PROD1 is ever rebuilt, re-apply `deploy/k8s-ingress-prod1.yaml.example`
(fill in the cert paths, `kubectl apply -f -`) as part of setup - it's not
automatic and nothing else re-creates it.

`serve` on both nodes binds all interfaces (0.0.0.0), not loopback -
restricting that to loopback crash-loops the installed `serve` version (see
the note in `deploy/ecosystem.config.cjs`). **Firewall ports 5174/5175,
same as port 4000 (backend), on both PROD nodes to intra-cluster/proxy
traffic only** - see step 8 - not the open internet, since nothing enforces
that at the app level.

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
