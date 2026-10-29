# Reservation workflow: offline development and deployment contract

This work is not deployed. Never apply these migrations through the normal quality
suite or against live Supabase without separate operator authorization. The approved
DBML, Prisma schema and original V2 migration remain unchanged.

## PROVISIONAL creation policies: instructor approval required before deployment

POST /api/reservations accepts only facilityId, purpose, startDatetime, endDatetime.
The existing pure structural validator trims purpose, counts Unicode code points,
requires timezone-aware valid timestamps, and rejects precision beyond milliseconds.
The authenticated user is the requester; approvedBy is NULL and the real Pending
lookup ID is resolved in PostgreSQL. All four agreed status names must exist; no
status is inserted or assigned a fixed ID. Pending requests may overlap each other.

PROVISIONAL: start must be strictly future at the database time check; maximum
duration is eight elapsed hours; both endpoints must be within 90 days of that
check; no buffers; creation is rejected if an Approved interval overlaps. Only
the exact existing facility status `Available` is eligible; all other strings are
unavailable. That eligibility interpretation also requires final policy review.
Boundaries are inclusive at eight hours and the 90-day horizon. PostgreSQL checks
these rules again, using its clock after facility locking; it does not trust the
API's clock or structural validation alone. SQL rejects submillisecond inputs too.

Real PostgreSQL verification exposed an eight-hour readback shift when the Windows
cluster's default timezone was Asia/Manila. The installed adapter-pg timestamptz
decoder assumes server UTC. Backend adapter startup options now explicitly pin UTC
for every connection; URL-level `options` overrides are rejected for operator review.
This does not weaken TLS or change credentials. Operators with custom startup options
must review that configuration before deployment. The isolated test retains the
non-UTC server default and uses the same UTC adapter option, so it checks the fix
rather than hiding the mismatch by changing the test server's timezone.

The actual create_reservation PostgreSQL procedure is called through a fixed,
parameterized CALL on the gateway transaction. Its INOUT reservation ID must start
NULL. Prisma receives the database-generated ID, reads the explicit scalar projection
inside that transaction and returns HTTP 201 only after transaction resolution.
Actor, role and status rows are locked during the procedure. Future procedures must
use the same facility locking and Serializable conflict-read protocol.

Only whitelisted SQLSTATE errors map to fixed HTTP 400/401/403/404/409/503 responses.
Serialization/deadlock conflicts return 409 without retries. Unknown errors and lost
commit acknowledgements return generic 500. No response proves rollback after a lost
connection; reconcile before any manual retry. No cleanup writes run after failures.

## Approval

POST /api/reservations/:id/approve accepts no query or body fields. It uses current
System Administrator RBAC and the actual approve_reservation procedure. PostgreSQL
rechecks active role, prohibits self-approval, requires Pending, locks the facility
then the reservation, and rechecks eligibility and all provisional time rules.
Only Approved records block the strict overlap predicate (start < end and end >
start); adjacency is allowed. The original requester is preserved and approvedBy
is the acting administrator. An audit UPDATE is required in the same transaction.

Concurrent callers use independent Serializable transactions, fixed lock ordering,
and conflict predicate reads. A conflicting transaction is refused, never silently
retried. Serializable isolation can conservatively reject otherwise nonconflicting
operations too. A 409 requires reloading; it is not permission to blindly retry a
write. Malformed JSON parser errors also receive Cache-Control: no-store.

## Rejection

POST /api/reservations/:id/reject uses current administrator RBAC and the actual
reject_reservation procedure. Only another user's Pending request may be rejected.
The procedure locks the same actor/status/facility/reservation sequence, changes
status to the real Rejected lookup ID, and leaves approvedBy NULL. AuditLog records
the rejecting actor independently. Duplicate and competing terminal transitions
return conflicts. No free-text rejection reason, editing, or reopening is added.

## Cancellation

POST /api/reservations/:id/cancel accepts no body/query fields. All approved roles
may cancel their own Pending or Approved reservation only before its start, checked
using PostgreSQL clock_timestamp after locks. PROVISIONAL: a current administrator
may also cancel another user's unstarted reservation. Other users' IDs receive the
same 404 as nonexistent IDs, with ownership checked in the procedure lookup itself.
The actual cancel_reservation procedure sets the real Cancelled ID and preserves
approvedBy, including the original approver on an Approved booking. AuditLog records
the cancelling actor. Rejected/Cancelled are terminal; no hard-delete, editing,
rescheduling, reopening or equipment allocation endpoint exists. An unknown commit
outcome never triggers cleanup or retry.

## Facility closure: PROVISIONAL

The additive BEFORE UPDATE OF status trigger guards the existing Facilities API.
Any resulting status other than exact `Available` requires a Serializable
transaction and all four status lookups. An Approved booking with end_datetime
strictly after the database decision time blocks closure, including already-active
bookings; completed bookings do not. Pending, Rejected and Cancelled do not block.
The existing API already uses Serializable transactions for updates. The facility
row lock and reservation predicate reads participate in the same protocol as
approval, preventing an approval/closure race from committing an unsafe final state.
Both operations can receive a conflict; no automatic retry is added.

The trigger changes no facility fields and introduces no new facility endpoint.
Unknown custom status strings continue to be accepted by the management API but
are considered unavailable for reservations. Existing NO ACTION foreign keys still
prevent deleting facilities with reservation history, including completed history.
Facility changes retain the existing administrator authentication/RBAC boundary;
this trigger does not add facility audit logging or claim independent JWT validation.

## Audit and role prerequisites

The additive audit migration requires operator-provisioned NOLOGIN, NOSUPERUSER,
NOCREATEROLE, NOCREATEDB, NOREPLICATION, NOBYPASSRLS roles named
`im101_reservation_owner`, `im101_reservation_audit_writer`, and
`im101_reservation_runtime`. These are PostgreSQL roles, not application Role rows.
Runtime must not inherit either privileged role, own protected objects, or have
effective reservation mutation/trigger/TRUNCATE or audit access privileges. The
migration rejects those unsafe runtime grants instead of revoking unrelated grants.
The deployment operator must inspect actual login memberships, schema CREATE rights,
column grants, ownership, default privileges, API exposure and RLS before deployment.
Do not use the database owner or a superuser as the application login.

The audit function runs as a dedicated definer with only audit INSERT/sequence USAGE
and user ID/activity reads. Its search_path is fixed; object references and snapshot
keys are explicit. PUBLIC function execution is revoked in the installation
transaction. Application callers cannot invoke it as an ordinary audit-write API.
No runtime audit SELECT, INSERT, UPDATE, DELETE or TRUNCATE is granted. Any audit
reader role, retention process or privileged correction requires separate review.
Existing management API grants are not broadly changed.

The AFTER ROW trigger records every INSERT, UPDATE (including no-ops), and DELETE.
Snapshots contain exactly reservation_id, facility_id, requested_by, approved_by,
status_id, start_datetime, end_datetime, created_at. Purpose is excluded. Timestamps
use UTC with six fractional digits. INSERT old_value and DELETE new_value are SQL
NULL. changed_at keeps the approved transaction-time default. Audit sequence gaps
are normal after rollback. Audit insertion failures abort the business write.
Rolled-back/failed attempts do not persist an audit row. TRUNCATE and privileged
DDL are not audited by this row trigger and must be denied to runtime.

The actor setting is a trusted backend claim, not independent authentication.
Existing JWT/database-backed RBAC remains required. The trigger checks a canonical
positive PostgreSQL integer actor and an existing active user. Any database caller
with suitable credentials can forge the setting; least-privilege login and procedure
access are essential. Owners/superusers can bypass protections and remain trusted.
No maintenance bypass or default actor is provided. No live statuses are provisioned.

Run isolated verification explicitly with `IM101_TEST_PG_BIN` set to the directory
containing trusted local PostgreSQL 17 binaries, then
`node scripts/test-reservations-postgres.js --local`. It creates a new private test
cluster, binds only 127.0.0.1 on a fresh port, generates SCRAM credentials, verifies
the server data directory, and creates a randomly named disposable database. It
never accepts a connection URL or uses DATABASE_URL. It stops its own cluster and
removes only its marker-verified temporary directory. No installed service is used.
The database fixtures and roles exist only inside that fresh cluster. Ordinary
quality tests do not launch this harness or execute migrations.

## API contract

All endpoints require existing bearer authentication and an active approved role.
Creation accepts exactly `{ facilityId, purpose, startDatetime, endDatetime }`.
Actions accept no query or body fields; absent body or `{}` is accepted. IDs must
be canonical positive PostgreSQL integers. Creation returns HTTP 201 and actions
return HTTP 200 only after transaction resolution, with
`{ success: true, reservation: { reservationId, facilityId, requestedBy, approvedBy,
statusId, purpose, startDatetime, endDatetime, createdAt } }`. Timestamps use the
existing Prisma UTC ISO millisecond JSON convention; unrelated fields and nested
records are excluded. All responses and parser errors use Cache-Control: no-store.
Structural validation errors return `{ success: false, errors: [{ field, code }] }`;
other refusals return `{ success: false, message }` with fixed public messages.

GET status/list/detail behavior is unchanged. Status IDs always come from real
lookup records, including nonstandard IDs. All four names must exist for writes;
extra unrelated lookup names do not participate. No status provisioning endpoint
or seed is added.

## Exact privilege responsibilities for deployment review

| Role                           | Grants introduced by these artifacts                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| im101_reservation_audit_writer | Schema USAGE; INSERT on six explicit audit columns; audit sequence USAGE; SELECT only user_id/is_active from users; ownership of audit function                                                                                                                                                                           |
| im101_reservation_owner        | Schema USAGE; reservation/facility/status SELECT; SELECT user_id/role_id/is_active and role_id/role_name; reservation INSERT and status_id/approved_by UPDATE; reservation sequence USAGE; minimum column UPDATE privileges needed for actor/role/status/facility row locks; ownership of procedures and closure function |
| im101_reservation_runtime      | Private schema USAGE and EXECUTE on only the four procedures; no new direct reservation mutation or audit privileges                                                                                                                                                                                                      |

Dedicated roles must be fresh, have no parent memberships or existing public table
ownership, and have no additional privileges outside this reviewed contract. The
deployment role owns the private schema and installs triggers. Temporary CREATE
grants used to transfer routine ownership are revoked within each migration.
Application logins must not be able to assume either owner role. Provisioning roles,
binding a least-privilege backend login, retaining necessary existing management and
authentication permissions, and granting reservation SELECT for GET APIs are explicit
operator prerequisites, not automatic credential/grant changes performed here.

Audit readers and retention are separate instructor decisions. No audit-read HTTP
endpoint or runtime audit-read grant is included. PostgreSQL owner/superuser access
cannot be made tamper-proof by these objects. Direct DML by those trusted operators
is auditable only with valid actor context; privileged DDL/TRUNCATE and failed attempts
need a separate approved audit mechanism. Database server logging configuration also
requires operator review; application diagnostics never print raw driver details.

## Isolated verification evidence and limits

The opt-in suite verifies original-migration replay, all four actual procedures and
CALL results with Prisma 7.10.1/adapter-pg, exact audit snapshots, microseconds,
purpose-only updates, real rollback and audit failures, a 15-second transaction
timeout, same-connection actor isolation, role restrictions and real HTTP APIs.
Concurrency scenarios use separate PostgreSQL connections, Serializable transactions,
and observed lock contention for overlapping approvals, competing transitions and
approval versus closure in both orders. Adjacent slots and simultaneous different
facilities are covered. Nonconflicting SSI refusals are allowed and never auto-retried.

One uncertainty test performs a real commit then synthetically loses its acknowledgement.
It proves the application does not interpret failure as rollback or duplicate the write;
it is not a real network fault-injection test. No external side effects, autonomous
cleanup or retries are performed by the production gateway. Real hosted pooler/TLS,
production-scale load, network partitions, standby/replication and privileged operator
behavior are not verified by this isolated suite. Node file modes do not guarantee a
Windows private DACL; generated test credentials/data are temporary and synthetic.
The harness never uses real credentials or campus data. Cluster initialization uses
--no-sync only to accelerate disposable initialization; this is not a durability test.

## Required human decisions and live deployment gate

Before live deployment, approve the provisional policies, exact facility eligibility
interpretation, no-op/purpose-only audit behavior, transaction-time audit timestamp,
reader/retention coverage, and any privileged maintenance procedure. No administrator
self-review exception is implemented. Equipment reservations and auditing of other
modules remain out of scope.

1. Review the six additive migration files and both definer-function boundaries.
   Verify protected-file integrity against the approved base and repeat local tests.
2. Inspect the target database read-only under separately authorized access: existing
   data validity/overlaps, four status names, facilities, ownership, memberships,
   table/column/sequence/schema privileges, default grants, RLS and Data API exposure.
   Do not assume current DATABASE_URL uses a restricted login. Do not expose the
   private schema through a client Data API.
3. Approve environment-specific role provisioning and backend login configuration.
   Verify effective direct reservation DML, TRUNCATE, audit access, schema CREATE,
   trigger alteration and role escalation are denied, including inherited grants.
   Review URL startup options, UTC behavior, V2 identity and verified TLS.
4. Obtain separate explicit approval for lookup provisioning (if needed), database
   migration and deployment. Apply only through the operator's reviewed process.
   There is no automatic deployment command in this feature or CI.
5. Apply additive migrations in order through the approved migration process. On
   partial installation failure, stop and inspect state; do not drop data or blindly
   resolve/replay migration history. Do not enable write traffic before all objects
   and effective permissions are verified.
6. Obtain separate authorization for any live verification. Review uncertain-outcome
   recovery first. There is no client idempotency key or operation receipt in the
   approved schema; after an ambiguous response, read and reconcile before deciding
   whether to submit a new request. Never assume generic 500 means no commit.

No live deployment, status insertion, or Supabase permission verification is claimed.
