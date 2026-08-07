# Advance → Clearance System

Internal system for staff travel advances, expense clearance claims,
accommodation requests, overtime, and attendance, routed through a
configurable, org-structure-aware approval workflow engine.

Full architecture, module map, database, and deployment documentation:
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Quick start (local dev)

```bash
# 1. Database
docker compose up -d

# 2. Backend
cd backend-v2
cp .env.example .env      # fill in DATABASE_URL, JWT_SECRET, etc.
npm install
npm run dev                # http://localhost:4000

# 3. Frontend
cd frontend
npm install
npm run dev                 # http://localhost:5173
```

Backend tests: `cd backend-v2 && npm test`.

## Deployment

See [deploy/README.md](deploy/README.md) for the CI/CD and PROD setup runbook.
