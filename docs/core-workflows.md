# Core modules: provisional policy and deployment contract

These features are local/offline development artifacts, not a live deployment.
The approved DBML, Prisma schema, original migration and six reservation migrations
are immutable. All new SQL uses separate additive migrations. No live statuses,
roles, credentials, grants, or database records are provisioned by development.

## Equipment loans

GET /api/loans lists bounded, paginated history; GET /api/loans/:id includes only
approved loan/item scalars. Representatives see their own requests; administrators
and maintenance staff may review all. POST /api/loans accepts dueDate and up to 50
unique `{ equipmentId, quantity }` items. Identity comes from authentication.
Dates must be explicit timezone-aware timestamps with millisecond precision;
PROVISIONAL maximum loan horizon is 90 days. Only exact Good equipment is eligible.

POST /:id/approve, /reject, and /return are administrator/staff operations with no
self-review, including self-recorded returns. Approval/rejection bodies are empty.
Return requires exactly all original item IDs with conditionIn Good or Damaged.
Partial returns are not representable by the approved loan-level return_date and
are deferred. Rejected/Returned are terminal; history has no deletion/edit endpoint.

A database BEFORE trigger, not a JavaScript stock calculation, performs approval
and return inventory updates. Equipment rows lock by ascending ID in one Serializable
transaction. Duplicate transitions cannot adjust stock twice. The database refuses
out-of-range quantities. Conditions at issue come from locked equipment. Returns
restore quantity; PROVISIONAL damaged returns mark the whole equipment pool Damaged
until an administrator clears it, because the schema has one condition per pool.

All these review, return, eligibility and horizon policies require final instructor
approval. Runtime actor context is a trusted backend claim, never independent JWT
verification. Existing JWT/database-backed RBAC remains mandatory. New context lookup
locks current user/role and exposes no password/email/contact fields.

## Deployment roles

Fresh NOLOGIN/NOSUPERUSER/NOCREATEROLE/NOCREATEDB/NOREPLICATION/NOBYPASSRLS roles
im101_core_owner, im101_core_runtime, im101_core_audit_writer are explicit operator
prerequisites. They must not inherit other roles or own existing public tables.
Core routine ownership has narrowly scoped loan/item/inventory and user/role-lock
permissions; secure search_path and qualified references are fixed. PUBLIC routine
execution is revoked. No normal core runtime DELETE privilege is granted. Existing
reservation ownership and grants are not modified. Operator review must bind the
actual backend login to the needed roles and retain existing authentication and
management permissions. Do not use a database owner login. Existing equipment CRUD
write permissions are a trusted backend boundary; direct credential access is not
equivalent to authorization through HTTP. Hosted effective grants, role memberships,
PUBLIC/default privileges, RLS and Data API exposure require separate live approval.

## Maintenance and assignments

Maintenance endpoints: GET/POST /api/maintenance, GET /:id, POST /:id/assign,
POST /:id/progress, PATCH /:id/priority, POST /:id/logs. Normal creation requires
exactly one facility/equipment target and the authenticated reporter. Description
is bounded to 4000 code points; action notes to 2000. Nullable historical targets,
reporters and assignees remain readable. No identity is invented for those records.
Administrators see all reports; staff see reports they made or are assigned to;
representatives see their own. Staff may claim only unassigned work for themselves;
administrators may assign any active eligible maintenance staff. Only administrators
or the assigned staff may progress work. Open -> In Progress -> Resolved is strict;
resolution uses database time. Related logs record the actual actor in the same
transaction. History is not edited or deleted. Priority is Low/Normal/High.

Assignment endpoints: GET/POST /api/assignments, GET/PATCH /:id, POST /:id/end.
Only administrators manage assignments; staff read their own, representatives are
denied. Filters support facilityId, staffId and active. AssignedRole is provisionally
Custodian/Maintenance Technician; shift Day/Evening/Night or NULL. Dates use UTC
calendar days, not future start dates. End dates cannot precede start or be future.
Ended history is immutable; an administrator may end an assignment after staff
deactivation. A partial unique index prevents duplicate active facility/staff/role
keys, including different shifts. Existing duplicates fail migration installation
without automatic cleanup. Facilities/staff/assigned dates cannot be rewritten.

These role, visibility, status, target, length, assignment and shift rules are
PROVISIONAL and require instructor approval before deployment. Unknown legacy
states remain readable and may need operator reconciliation before normal writes.
GET /api/staff supplies administrators only eligible staff IDs/names; GET lookup
catalogs and /api/overview use bounded selectors or role-scoped actual counts.

## Extended audits

The dedicated core audit writer owns one secure trigger function covering scalar
primary keys on equipment_loans, maintenance_requests, maintenance_logs and
facility_staff_assignments. Explicit snapshots omit maintenance description and
action_taken, passwords, JWTs and unrelated personal data. Audit INSERT/UPDATE/DELETE
shares the business transaction and fails closed without active actor context.
No new runtime audit read/write permission is granted. Existing reservation auditing
and its six migrations are unchanged. LoanItem composite-key auditing is deliberately
deferred pending an instructor-approved record_id convention; no hash/concatenated
identifier is fabricated. Per-item condition/quantity history is stored and guarded
in LoanItem but is not claimed as independently audited. Inventory bounds are guarded
for every equipment write; stock changes are driven atomically by loan transitions.

The runtime role has no normal DELETE grants on these histories. Append-only
maintenance actions cannot be updated through that role. New definer functions use
fixed identifiers/search paths, no dynamic SQL, and selected user/role-lock privileges;
the database audit writer can only insert approved audit columns and read user
ID/activity. Actual backend logins remain trusted and must never reach browsers.
No claim is made that arbitrary database-owner SQL is confined to HTTP workflows.

Apply migrations only after separate live approval and effective-grant review.
Use the existing opt-in disposable PostgreSQL harness for local checks; normal
quality/CI must never select DATABASE_URL for migration or seed execution.

## React workspace

The client uses actual API data for overview, buildings, facilities, equipment,
reservations, borrowing, maintenance and staff assignments. Navigation and actions
follow the authenticated canonical role; backend checks remain authoritative.
Administrators manage catalogs, review reservations/loans, oversee maintenance and
manage assignments. Staff request reservations/loans, review other borrowers' loans,
claim assigned work and read their assignments. Representatives request reservations,
loans and maintenance and see only their authorized histories.

Login obtains a short-lived bearer token held only in memory. Logout, expiration,
401 responses and browser refresh clear the session; no refresh-token or persistent
browser storage mechanism is introduced. The API client uses same-origin requests,
fixed sanitized error text, explicit Authorization and no cookies or automatic write
retry. A failed or uncertain mutation requires closing the form and reloading history
before trying again. Check the resulting state first; never blindly repeat a return,
approval or creation after a lost response. Consequential actions name their target
and require confirmation. Forms prevent duplicate submissions and refresh data after
confirmed success. Server-side idempotency keys are not implemented.

Dates entered as local wall time are checked and converted to explicit UTC timestamps;
tables display the browser's local time. Date-only assignment fields remain UTC days.
Daylight-saving repeated wall times still require operator care. JSON requests retain
the existing 8 KB server cap, in addition to per-field limits. Catalog selectors show
the first 100 actual records, with Load more for additional name-based choices.
Displayed record names missing from loaded choices resolve through existing catalog
detail reads; unavailable targets use neutral labels rather than numeric IDs.
Maintenance detail currently includes all authorized action logs; very large histories
will need separate log pagination. Partial loan returns and per-unit repair tracking
remain deferred by the existing schema.

Install both lockfiles with `npm ci` and `npm --prefix client ci`. Run the backend
normally only with operator-approved configuration; run `npm --prefix client run dev`
for the local UI proxy. `npm --prefix client run build` needs no database and emits
ignored static assets. Express serves only that built directory with a restrictive
same-origin CSP. Source files, environment files and receipts are never served.
No deployment, database migration or automatic provisioning is added to CI.

## Verification and release gates

The ordinary quality suite includes backend mocks, frontend component/API tests,
lint, formatting, schema validation, syntax checks and a frontend production build.
Mocks establish request/response and authorization predicates, not PostgreSQL locking.
The opt-in `npm run test:postgres` harness instead starts its own marked, disposable,
loopback PostgreSQL cluster with synthetic credentials and applies the original plus
all additive migrations there. It never reads the application DATABASE_URL. Native
PostgreSQL binaries or the existing supported disposable runner are prerequisites.

Integration scenarios cover loan lifecycle and inventory, independent connections
competing for the last units, maintenance status/log rollback, competing assignments,
audit allowlists and failures, actor/role restrictions, migration replay, existing CRUD
and reservation concurrency. These are local database results, not hosted privilege,
pooler, network, RLS or deployment verification. Browser component tests do not replace
an operator acceptance test with approved accounts. Login throttling and HTTPS remain
public-deployment prerequisites from the existing authentication contract.

Before live release obtain approval of all provisional policies and migrations;
review role ownership, membership, effective table/column/sequence/default/PUBLIC
grants and hosted exposure; bind the backend login to narrowly scoped runtime roles;
resolve duplicate active assignments; approve status lookup provisioning separately;
review backup/recovery and deployment ordering. Audit INSERT permission and sequence
access must be verified without granting audit modification to the runtime login.
Do not apply these artifacts to Supabase as part of tests, builds or normal startup.
