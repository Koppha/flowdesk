# Advance Clearance Backend V2

Clean rewrite of backend foundation with stricter validation, explicit workflow transitions, and automated tests.

## Run

1. Copy `.env.example` to `.env` and set values.
2. Install dependencies: `npm install`
3. Start dev server: `npm run dev`
4. Run tests: `npm test`

## Current scope

- Health endpoint
- Auth login endpoint
- Advance workflow endpoints with state-machine transitions:
  - create
  - submit
  - countersign
  - approve
  - mark paid
