# Campus availability and schedule conflicts

## Read-only availability API

`GET /api/reservation-availability?from=<ISO timestamp>&to=<ISO timestamp>`
requires existing JWT authentication, an active database account and one of the
three canonical application roles. This endpoint deliberately shares campus-wide
time slots; it does not change the ownership scope or projection of either
existing reservation GET endpoint. Other users' private reservation details
continue to return 404 to unauthorized nonadministrators.

Required from/to timestamps use the existing strict structural timestamp validator
(valid calendar dates, explicit timezone and milliseconds at most). The range is
half-open and must be increasing and at most 45 elapsed days. Optional facilityId
is a positive PostgreSQL integer. Optional page is 1–100 (default 1), limit 1–100
(default 100). Unknown, repeated, malformed or excessive parameters return 400.
Each query takes at most 101 rows, ordered by unique reservationId, and applies
time, facility and status predicates in PostgreSQL before pagination. There are no
unbounded counts, database writes, automatic lookup inserts or raw SQL operations.

Response: `{ success: true, availability: [...], pagination: { page, limit,
hasMore } }`. Each slot contains exactly facilityId, facilityName, startDatetime,
endDatetime and status (Pending or Approved). IDs are internal facility-selector
values, not user-facing labels. No reservation ID, requester/approver ID, user
relation, name, email, purpose, creation timestamp or equipment details are
selected or returned. Reservation IDs appear only in the internal ordering.
Rejected and Cancelled rows are excluded in the database query. Responses use
no-store; unexpected errors use the existing sanitized handler.

The calendar queries its 42-day local month grid using UTC ISO boundaries, and
displays times in the viewer's local timezone. Asia/Manila formatting is tested
in a separate Node process using TZ=Asia/Manila. Mobile uses an agenda. Filtering
or changing months aborts previous requests. The facility selector can load more
catalog choices. Pagination is explicit, with partial/unknown warnings; no blank
day claims that a facility is available. Even a fully loaded view is only a live
snapshot, not a promise of availability. Page-based results can change as other
users act; refreshing starts a new snapshot. More than 10,000 slots per range
requires narrowing filters/range rather than fetching unbounded history.

Calendar items open a minimal time-slot dialog, never the private reservation
detail endpoint. Tentative/Confirmed labels, status text and dashed/solid borders
distinguish Pending and Approved without relying on color. Successful local
reservation creation/approval/rejection/cancellation refreshes the resource
revision; the calendar reloads when mounted or when that revision changes. Other
users' changes become visible on Refresh calendar; there is no realtime push or
claim of global availability locking.

## Confirmed overlap versus other conflicts

The existing reviewed procedures use R4091 for multiple different refusals.
Neither the original SQL nor any migration is edited. The backend recognizes
only the exact pair R4091 + the fixed message `Reservation schedule conflict.`
from the driver (including Prisma adapter metadata). It maps that pair to safe
public code `RESERVATION_SCHEDULE_CONFLICT`, HTTP 409. Only the fixed code and
static public message are returned: raw SQL/driver messages are never echoed.

R4091 with another message, SQLSTATE 40001/40P01 and Prisma P2034 remain
`RESERVATION_CONFLICT`, not a claimed booking collision. Other malformed or lost
acknowledgements remain sanitized errors with uncertain outcomes. The procedure
still owns conflict prevention; the calendar never authorizes a write.

The client accepts the schedule-specific code only on a reservation mutation
endpoint with HTTP 409. A confirmed creation collision opens the accessible
Schedule Conflict dialog, showing the chosen facility and requested interval.
No other booking interval is shown because this mutation response does not
confirm one. Choose Another Schedule restores the existing draft and focuses
the start-time input. Escape/close returns to the draft too. No automatic retry
occurs. Generic 409/unknown outcomes tell users to refresh/check request history
before resubmitting, and the editor blocks another submission until refreshed
through its existing close/reopen flow. The optional View Calendar link is not
included to avoid discarding the active draft.

Pending overlaps, Approved-only blocking, strict overlap inequalities, adjacency,
separate-facility independence, duration/future/90-day constraints, Serializable
transactions and audit recording remain controlled by the unchanged procedures.
The adapter-message classification is a compatibility contract: rerun the real
PostgreSQL tests if procedures or the Prisma adapter change.

## Permissions, verification and deployment

Read-only verified-TLS inspection of approved Supabase V2 confirmed the existing
im101_render_app login already has SELECT on the needed reservation ordering/FK/
interval columns, facility ID/name and reservation-status ID/name. No additional
database permissions are needed for availability. No grants, RLS, Data API settings,
schema, migrations, existing users/passwords or campus records were changed.
Registration's separately documented deployment blockers are not resolved by this
feature and must not be bypassed when releasing the combined branch.

Offline tests verify canonical roles, active authentication, filters/pagination,
minimal field projection, sanitized failures, calendar privacy and incomplete
states, refresh, date conversion, focus/draft restoration and rejection of false
schedule classifications. The opt-in isolated PostgreSQL suite additionally uses
two synthetic Representatives, real Express endpoints and actual procedures to
verify cross-user safe slots, private-detail 404, Pending overlap, Approved
conflict codes, adjacent/different-facility requests and rejection/cancellation
removal. Existing independent-connection concurrency tests continue to run.

Review the new branch and tests, resolve any inherited registration release
blockers, approve merge/deployment, and deploy the normal Node build without
migrations, seeding or permission changes. With separately authorized accounts,
smoke-test the availability GET and filters before any live reservation writes.
Desktop/mobile visual acceptance remains pending when Computer Use is blocked;
automated DOM and responsive tests do not substitute for browser acceptance.
