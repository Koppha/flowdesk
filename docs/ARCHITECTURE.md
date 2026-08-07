# Advance → Clearance System — Documentation

Internal system for staff travel **advances**, expense **clearance claims**,
**accommodation** requests, **overtime**, and **attendance**, routed through a
configurable, org-structure-aware **approval workflow engine**.

## 1. Stack

| Layer      | Tech |
|------------|------|
| Database   | PostgreSQL 16 |
| Backend    | Node.js + TypeScript, Express 4 (`backend-v2/`) |
| Frontend   | React 18 + Vite + TypeScript (`frontend/`) |
| Auth       | JWT (`jsonwebtoken`), optional Active Directory login |
| Email      | HTTP email API (AD) primary, SMTP (nodemailer) fallback |
| PDF        | `pdfkit`, admin-configurable templates |
| Deploy     | PM2 (`ecosystem.config.cjs`) behind nginx, GitLab CI → PROD1/PROD2 |

Legacy `backend/` and `teams-app/` directories predate `backend-v2` and are
not part of the current deployment path — `backend-v2` is the live backend.

## 2. Repository layout

```
advance-clearance-system/
├── backend-v2/           Express API (source of truth for business logic)
│   ├── src/
│   │   ├── app.ts        Router wiring, middleware, cache headers
│   │   ├── index.ts      Process entrypoint
│   │   ├── bootstrap/system.ts   Idempotent schema migrations + boot seeding
│   │   ├── config/env.ts Zod-validated environment config
│   │   ├── lib/          Shared logic: auth, db, workflowEngine, notifications...
│   │   └── modules/      One folder per domain (routes + logic co-located)
│   └── tests/            Vitest
├── frontend/src/          React SPA, one component per feature/page
├── db/schema.sql          Base schema loaded once by docker-compose (UAT) /
│                          manually on first PROD deploy — NOT the full live
│                          schema (see §5)
├── deploy/                PM2 config, nginx examples, CI/CD runbook (README.md)
├── docker-compose.yml     Local Postgres for development
└── .gitlab-ci.yml         Build → test → deploy to PROD1/PROD2
```

## 3. Domain modules (`backend-v2/src/modules/`)

Each module owns its own routes file(s) and is mounted in `app.ts`:

| Module | Route prefix | Purpose |
|---|---|---|
| `auth` | `/auth` | Login (local + AD), users, departments, directory |
| `advances` | `/advances` | Travel advance requests (submit, approve, pay) |
| `accommodation` | `/accommodation-requests`, `/accommodation` | Hotel/accommodation requests + quotations |
| `claims` | `/claims` | Clearance claims (reconciling an advance after travel) |
| `overtime` | `/overtime` | Overtime requests and claims |
| `attendance` | `/attendance` | Attendance records |
| `travel` | `/travel` | Travel types, locations (reference data) |
| `workflows` | `/workflows` | Workflow Builder CRUD — see §6 |
| `reporting-lines` | `/reporting-lines` | Employee → manager hierarchy (org chart, separate from dept leadership) |
| `request-types` | `/request-types` | Configurable request-type metadata |
| `custom-requests` | `/custom-requests` | Ad-hoc/custom request types |
| `deductions` | `/deductions` | Payroll deduction tracking |
| `inbox` | `/inbox` | Per-user unified approval inbox across all request types |
| `email-actions` | `/email-actions` | One-click Approve/Reject links from email (renders its own HTML page) |
| `pdf-templates` | `/pdf-templates` | Admin-designed PDF layouts for generated documents |
| `ai` | `/ai` | Lightweight NL query parsing over reporting data (keyword/regex based, not an LLM) |
| `health` | `/health` | Liveness check |

## 4. Roles

Roles are defined by the `role_type` Postgres enum and mirrored by
`frontend/src/roles.ts` (`ROLE_LABELS`): `EMPLOYEE`, `MANAGER`, `HOD`,
`FINANCE`, `ADMIN`, `EXCO`, and `CEO`.

Org structure is **Division** → **Department** → **Section** → **Team** (a
user carries `division_id`/`section_id`/`team_id` plus a legacy free-text
`department`; departments and sections each link to one or more divisions
via junction tables). Each level has an optional leadership user
(`manager_user_id` / `hod_user_id` / `exco_user_id` / `leader_user_id`) that
the workflow engine resolves against when a step is scoped to a position
rather than a named individual — see
[`docs/TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md) §Data Model for the full
table reference. A separate `reporting_lines` table expresses an explicit
employee→manager hierarchy that can override this structure (§6).

## 5. Database

`db/schema.sql` is loaded once — by docker-compose on local UAT setup, and
manually (`psql "$DATABASE_URL" -f db/schema.sql`) on a PROD server's very
first deploy. It defines the base tables (`users`, `workflows`,
`workflow_steps`, `workflow_rules`, `sections`, `departments`,
`advance_requests`, `advance_lines`, `accommodation_*`, `clearance_claims`,
`attendance_records`, `overtime_*`, `receipts`, `approvals`, `audit_log`, ...).

**The live schema is materially ahead of `schema.sql`.** Every additional
column/table introduced since (e.g. `advance_requests.workflow_id`,
`workflow_step_order`, `approval_chain`, the `reporting_lines` table, teams,
employment types, PDF templates, deductions, ...) is applied by idempotent
`ensure*Schema()` functions in `backend-v2/src/bootstrap/system.ts`, run on
every process boot (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT
EXISTS`, etc.). There is no separate migrations folder — `system.ts` is the
authoritative, current schema definition. When documenting or debugging a
table's actual shape, check `system.ts` before `schema.sql`.

## 6. Workflow engine

The approval engine is fully driven by the admin-configured **Workflow
Builder** — there is no hardcoded approval chain.

- **`backend-v2/src/lib/workflowEngine.ts`**
  - `resolveWorkflowChain(params)` — finds the best-matching `ACTIVE`
    workflow for a request and resolves each step's assignee(s) against the
    org structure, returning an array of `ChainStep` objects.
  - `chainStepToStatus(chain, stepIndex)` — maps a step's
    `position_type_code` to the request's `AdvanceStatus` (e.g. `MANAGER` →
    `SUBMITTED`, `HOD`/`EXCO_OWNER` → `COUNTERSIGNED`, `FINANCE` →
    `HR_OFFICER`).
  - `canApproveStep(step, userId, userRole, delegatedManagerId?)` — access
    check for whether a given user may act on the current step.

- **Workflow types**
  - `STICKY` — the permanent default workflow for a department/request type.
  - `TEMPORARY` (with `valid_from`/`valid_until`) — a time-bounded override
    that takes priority over `STICKY` while active.

- **Step assignment** (`workflow_steps.position_type_code`): each step is
  scoped to a position (`MANAGER`, `HOD`, `EXCO`, `HR_REVIEW`, `FINANCE`,
  `CUSTOM`, ...) and optionally further scoped to a specific
  team/section/department. The Workflow Builder's "Assign to" picker
  (`frontend/src/WorkflowBuilder.tsx`) resolves and filters the candidate
  user list live so admins only see people who actually match the step's
  scope — e.g. a section-scoped `MANAGER` step only offers managers whose
  `section_name` matches (falling back to department-level managers when no
  section-specific manager exists).

- **Submit** — `resolveWorkflowChain` runs at submission time; the request
  is rejected if no `ACTIVE` workflow matches. The resolved chain is frozen
  onto the request as `approval_chain` (jsonb), with `workflow_id` and
  `workflow_step_order = 0`.
- **Approve** — `canApproveStep` gates the action; on success
  `workflow_step_order` increments. Reaching the final step sets
  `status = APPROVED`. `ADMIN` can force-advance any step. Legacy requests
  with no `approval_chain` fall back to a hardcoded `ADMIN`-only path.
- **Rollback** — resets the request to `DRAFT` and clears `workflow_id` /
  `workflow_step_order` / `approval_chain`; the chain is re-resolved from
  scratch on next submit (picks up any workflow config changes made in the
  interim).
- **Reject** — sets `status = REJECTED` (terminal).
- **Inbox** — `loadWorkflowAdvancesForUser(userId)` queries requests where
  `approval_chain[workflow_step_order]->>'approver_id' = userId`; legacy
  requests are still matched by status + department ownership.
- **Frontend** — `buildTrackingStages` in `App.tsx` renders the tracking UI
  from `approval_chain` when present, falling back to legacy status-based
  rendering otherwise. `Inbox.tsx` gates approve/rollback/reject actions on
  `item.current_step_approver_id === me.userId` for workflow-driven requests.

## 7. Auth

- Local auth: email + bcrypt password hash, JWT session.
- Optional Active Directory auth (`AD_AUTH_ENABLED`): authenticates against
  an internal LDAP proxy API, with configurable local-account fallback
  (`AD_FALLBACK_LOCAL`) and synthetic email domain for AD-only accounts.
- Production startup guards (`config/env.ts`) refuse to boot if
  `CORS_ORIGIN` is unset (would reflect any origin with credentials enabled)
  or if the default admin seed password hasn't been overridden.

## 8. Notifications

- Primary transport: an internal HTTP email API (`EMAIL_API_ENABLED`) that
  talks to Active Directory's mail service.
- Fallback transport: SMTP via `nodemailer` (`SMTP_ENABLED`), used only when
  the email API is disabled.
- Optional Microsoft Teams incoming-webhook notifications (`TEAMS_ENABLED`).
- Email-embedded one-click "Approve"/"Reject" links (`email-actions` module)
  let approvers act without logging in; token-gated and rendered as a
  self-contained HTML confirmation page.

## 9. Frontend

One top-level React component per feature area in `frontend/src/`, switched
by a `Page` union type in `App.tsx` (e.g. `WorkflowBuilder`, `Inbox`,
`MyAdvances`, `MyClearances`, `AttendanceModule`, `OvertimeModule`,
`ReportingLines`, `OrgStructure`, `UserManagement`, `PdfDesigner`, and the
`Report*` analytics pages). Built with Vite; production build is served
statically behind nginx with `/api/` proxied to the backend (frontend calls
are built with `VITE_API=/api`, backend routes are root-level — nginx strips
the `/api` prefix).

## 10. Running locally

```bash
# 1. Database
docker compose up -d

# 2. Backend
cd backend-v2
cp .env.example .env      # fill in DATABASE_URL, JWT_SECRET, etc.
npm install
npm run dev                # tsx watch, http://localhost:4000

# 3. Frontend
cd frontend
npm install
npm run dev                 # http://localhost:5173
```

Backend tests: `cd backend-v2 && npm test` (Vitest).

## 11. Deployment

Full runbook: [`deploy/README.md`](../deploy/README.md).

Summary: GitLab CI (`.gitlab-ci.yml`) builds/tests on every merge to `main`
and deploys to two active-active PROD servers (PROD1/PROD2) behind a shared
load balancer, both pointing at one shared Postgres instance. Zero-downtime
deploys via PM2 (`pm2 reload`) against a repointed `current` release
symlink. `deploy/nginx-advance-clearance.conf.example` and
`deploy/nginx-email-action-proxy.conf.example` cover the reverse-proxy and
optional email-action-only public exposure.

## 12. Related documentation

- [`docs/TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md) — full technical
  specification: functional requirements, complete API contract, full
  database schema reference, and process flow diagrams.
- [`deploy/README.md`](../deploy/README.md) — CI/CD setup runbook (runner,
  deploy keys, PROD bootstrap, nginx, email-action proxy).
- [`docs/advance-clearance-educational-slides.html`](advance-clearance-educational-slides.html) —
  slide-deck walkthrough of the business process.
