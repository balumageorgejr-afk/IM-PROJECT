# Application acceptance and safe demonstration sequence

## Current result

Local main was clean and fast-forwarded to `9c0459a` (merged PR #27). The PR quality
workflow completed successfully. Dependencies required by both lockfiles were already
installed; no dependency or credential changes were needed.

The synchronized application passed the complete offline quality suite: 258 backend
tests, Prisma validation/format, Prettier, syntax, ESLint, frontend tests and production
build. Expanded acceptance cases bring frontend coverage to 32 tests. Both server and
client dependency audits reported zero vulnerabilities. The new cases exercise staff
assignment visibility and maintenance claim/progress, administrator approval/rejection
without self-review, representative cancellation and forbidden assignment navigation.
They use the existing synthetic accounts and mocked fetch responses, not real users
or a database. They do not establish transaction or browser-rendering safety.

Express and Vite started on loopback. HTTP checks returned 200 for Express health,
the Vite index, Vite's API health proxy and the built client served by Express.
The built index has the configured CSP. An unauthenticated reservation request
returned 401 with no-store. The acceptance Express instance explicitly refused all
database access through dependency injection and used an ephemeral test-only JWT
secret. It was a safe shell/proxy check, not an authenticated application demo.
Both owned preview servers were stopped after these checks to release their ports.

Computer Use stopped because it could not establish the current Windows browser URL
confidently enough for its policy checks. No further browser input was attempted.
Login appearance, sidebar, tables, mobile layout and interactive visual acceptance
are therefore NOT verified in this pass. Component tests are not visual acceptance.

No migrations, role provisioning or live data changes were performed in this pass.
The PostgreSQL integration harness was not rerun because it installs migrations and
roles in its disposable cluster, which requires clarification of the current
no-migration restriction. The previously recorded 52 PostgreSQL scenario groups are
historical PR #27 evidence, not a fresh result from this acceptance pass. No approved
local database/accounts were connected to the UI, and no Supabase access occurred.

## Demonstration gates

| Capability                                                    | Evidence now                              | Remaining gate                                                                       |
| ------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| Dependency install, lint, formatting, schema checks and build | Passing locally and prior PR CI           | Repeat after any approved fix                                                        |
| Authentication, ownership and workflow request contracts      | Offline backend/component tests           | Browser login with approved local accounts                                           |
| Inventory, audits and reservation concurrency                 | Historical disposable PostgreSQL evidence | Explicit permission to rerun the harness or approved existing local test environment |
| Express/Vite/static hosting/proxy                             | Local HTTP smoke checks                   | Connect only an approved target                                                      |
| Three-role browser workflows and responsive design            | Not verified visually                     | Available browser tooling or operator acceptance                                     |
| Hosted database and production security                       | Not verified or deployed                  | Separate environment, grant, migration and release approval                          |

## Exact safe local demonstration order

1. Keep the approved DBML, Prisma schema and all reviewed migrations unchanged.
   Confirm a clean checkout of the reviewed commit with `git status --short`.
2. On Node.js 24 install missing dependencies from lockfiles only:

    ```sh
    npm ci
    npm --prefix client ci
    npm run quality
    npm audit
    npm --prefix client audit
    git diff --check
    ```

3. Choose the database path explicitly. Either authorize the existing self-contained
   local PostgreSQL harness for a fresh verification run, or supply an existing,
   already initialized disposable local environment with approved accounts. The
   harness is automated testing and terminates/removes its cluster; it does not
   provide a persistent browser demonstration environment. A persistent demo setup
   needs a separately reviewed setup/lifecycle procedure. Never substitute the normal
   application DATABASE_URL or assume a running localhost service is disposable.
4. Verify target identity, local ownership, database version, UTC configuration,
   initialization history and absence of real campus data before any approved writes.
   Obtain test-account credentials privately from the operator. Do not reuse campus
   passwords, print secrets, commit environment files or put tokens in browser storage.
5. Only after the local configuration is approved, start the normal backend with
   `npm run dev` using the reviewed local environment. Start
   `npm --prefix client run dev` in another terminal and open the printed loopback URL
   (normally http://127.0.0.1:5173). Health 200 alone does not prove database readiness.
   If port 5000 or 5173 is occupied, identify its owner; do not kill unrelated processes.
6. Verify login/logout/session expiry for each approved role. As a representative,
   browse facilities/equipment, create a future reservation, request equipment, report
   maintenance and inspect only authorized history. Cross-user detail requests must
   return 404 as designed. Never use real campus records for these steps.
7. As another administrator, approve/reject pending reservations without self-review;
   approve/reject a loan and record a full return once; assign maintenance work and
   manage/end a staff assignment. Confirm resulting history and quantities, not only
   success toasts. Use separate synthetic requests for mutually exclusive transitions.
8. As maintenance staff, inspect own assignments and authorized reports, claim an
   eligible unassigned own report, start work, record an action and resolve it.
   Review other borrowers' loans only within the documented provisional permissions.
   Verify unavailable controls and actual backend denials for forbidden operations.
9. Check desktop and narrow mobile widths, keyboard focus/tab/Escape, visible labels,
   table scrolling, pagination, empty/loading/error states and timezone display.
   Test an intentional conflict and a session expiry. Never repeat an uncertain write
   before inspecting history; no automatic write retry or idempotency key exists.
10. Record screenshots and pass/fail evidence using synthetic data only. Re-run tests
    and build after fixes, review the diff/secrets, and use a separate reviewed PR.
    Stop the owned local servers when finished; preserve all history and ACLs.

## Exact future hosted release order (not authorized for execution)

1. Approve provisional business policies in [core workflows](core-workflows.md) and
   [reservation workflow](reservation-workflow.md). Decide whether deferred LoanItem
   composite-key auditing, partial returns and maintenance-log pagination affect the
   demonstration or release acceptance criteria. Do not silently expand the schema.
2. Obtain separate written approval identifying the hosted project, environment,
   allowed migration/lookup/account actions, operator and maintenance window. Verify
   V2 identity, certificates/TLS, backups and a tested restore/roll-forward plan.
3. Review current schema/migration history and duplicate active assignment keys without
   modifying them. Never replay the original initialization migration into an existing
   initialized database. Do not edit migrations to work around inconsistent history.
4. Review the six dedicated NOLOGIN roles: im101_reservation_owner,
   im101_reservation_audit_writer, im101_reservation_runtime, im101_core_owner,
   im101_core_audit_writer and im101_core_runtime. An authorized operator must approve
   creation/ownership, memberships, table/column/sequence/default/PUBLIC grants,
   execution grants, RLS and Data API exposure. The backend login must not be a database
   owner or assume routine/audit owner roles. Existing authentication and catalog CRUD
   permissions must remain available without granting audit modification.
5. Rehearse the approved deployment on an isolated staging copy first. After specific
   approval, apply only missing reviewed additive migrations in timestamp order:
   reservation_audit, reservation_create, reservation_approve, reservation_reject,
   reservation_cancel, facility_reservation_guard, core_loan_workflow,
   maintenance_assignments, core_audit. Each migration has its own transaction;
   this is not one atomic nine-migration deployment. A failure requires inspection,
   not blind retry or assuming earlier migrations rolled back. No command here runs
   these changes automatically.
6. Separately approve lookup provisioning for Pending/Approved/Rejected/Cancelled and
   required facility/equipment catalogs. Use actual IDs; do not hardcode or fabricate
   them. Approve any test-account setup independently and keep credentials private.
7. Verify effective grants, audit failure rollback, actor attribution, pooler/UTC/TLS
   behavior, concurrency and existing API compatibility in that approved environment.
   Local mocks and native PostgreSQL cannot establish hosted permission guarantees.
8. Configure HTTPS, strong private JWT configuration, reviewed connection pooling,
   login throttling, private logs and operational monitoring before public exposure.
   Build the frontend with `npm --prefix client run build`; Express serves only
   client/dist. Do not serve the repository or use Vite's development server publicly.
9. Perform explicitly authorized smoke tests using positively identified disposable
   records and approved accounts. Preserve loan/maintenance/assignment history; do not
   introduce hard-delete cleanup. Obtain final operator release acceptance separately.

There is no deployment, migration, seeding or live verification authorization implied
by this runbook. Hosted release and a fully authenticated browser demonstration
remain blocked until their environment and acceptance gates are satisfied.
