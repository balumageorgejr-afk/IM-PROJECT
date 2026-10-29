# Campus Facility Management System

An IM101 project for managing campus facilities, equipment, reservations, loans, and maintenance. The backend provides authenticated management workflows and a role-aware React workspace. Database additions are verified against disposable local PostgreSQL, but remain unapplied to live Supabase and require deployment approval.

The stack is Node.js 24, Express 5, JavaScript (CommonJS backend), Prisma 7.10.1, PostgreSQL, React and Vite.

The [frontend redesign guide](docs/frontend-ux-redesign.md) describes the role-specific dashboards, card-based browsing, searchable request forms, responsive calendar and current verification limits.

The [reservation UI guide](docs/reservation-ui-usability.md) explains named facility/equipment choices, consistent date formatting, full-purpose details and the read-only Approved calendar. Calendar visibility follows the existing account permissions.

## Folders

- `src/`: the Express app, server, database connection, authentication, and Buildings, Facilities, and Equipment routes.
- `client/`: React workspace, centralized API/session handling, forms, tables and frontend tests.
- `tests/`: database-free authentication, role, Buildings, Facilities, Equipment, and operator-tool tests with controlled fixtures.
- `prisma/`: the approved Prisma schema and V2 initial migration.
- `docs/`: the [professor-approved database design](docs/professor-approved-schema.dbml).
- `scripts/`: quality checks, read-only database/login verification, and operator-only account provisioning and password recovery.
- `.github/workflows/`: database-free quality checks for GitHub Actions.

The approved design has 16 application entities, 97 physical fields, and 24 foreign keys. The Prisma schema and V2 migration are preserved unchanged. These setup commands do not apply migrations.

## Install and run

Install Node.js 24, then run:

```sh
npm ci
npm --prefix client ci
npm run prisma:generate
npm run dev
```

Set a private `JWT_SECRET` containing at least 32 bytes of cryptographically random secret material in `.env` or the process environment before starting. No default secret is provided; invalid configuration prevents startup. Open http://localhost:5000/api/health. Use `npm start` to run without automatic restarts. The health endpoint does not access PostgreSQL and does not check database readiness.

Run `npm run quality` for schema validation, formatting, JavaScript syntax, lint checks, and the full automated test suite. `npm test` runs only the database-free tests. `npm run audit` checks dependency advisories.

In a second terminal, run `npm --prefix client run dev` and open the printed local Vite URL. Its `/api` proxy targets the backend at localhost:5000. No example credentials or demo records are provided. Login requires an operator-configured backend; frontend tests and builds need no database. Bearer tokens remain in memory, expire after the server lifetime, and are cleared on logout or refresh.

Run `npm --prefix client run build` to create ignored `client/dist` assets, which Express can serve at `/`. Hash navigation supports direct page links without a server fallback. Run `npm --prefix client run quality` or `npm --prefix client audit` for client-only checks. See [core workflows and deployment prerequisites](docs/core-workflows.md) before configuring database permissions or enabling the new workflows.

## Database connection

Keep the V2 Session pooler `DATABASE_URL` in your private local `.env` or process environment. Confirm the Supabase project reference is V2 before running `npm run db:check`. Never commit credentials.

The unchanged `prisma-client-js` generator produces CommonJS-compatible JavaScript in `node_modules/.prisma/client`, exposed through `@prisma/client`. Prisma 7.10.1 uses `@prisma/adapter-pg` and the `pg` driver for PostgreSQL; both are already dependencies. No ESM conversion or schema change is needed.

`src/db.js` exports `getPrisma()`. It loads environment variables quietly and creates one reusable client on first use, with one adapter-owned pool capped at five connections and ten-second connection/query timeouts. Importers share this client through the CommonJS module cache. Callers must catch connection/query failures without exposing raw driver errors and call `await prisma.$disconnect()` when their process finishes using the database.

`npm run db:check` connects, runs only `SELECT 1 AS ok`, and disconnects even after a failure. It prints PASS/FAIL and exits with code 0/1. Failures intentionally omit driver details to protect credentials. It does not read application tables. The Express health endpoint remains independent of this module.

Equipment loans, maintenance and staff assignments now have authenticated APIs and frontend workflows. Their three additive migrations and the six reservation migrations are reviewable artifacts, not deployed database objects. No lookup values are provisioned automatically. Run `npm run prisma:generate` after installing dependencies or updating Prisma Client.

## Account registration (prepared offline)

Public `POST /api/auth/register` creates active Representative accounts only.
Administrator-only `POST /api/accounts/staff` creates active Staff accounts only.
Both accept exactly `fname`, `lname`, `email`, `password` and
`passwordConfirmation`. Roles are resolved by the server, passwords are hashed,
and existing accounts are never updated. The grayscale login includes Sign Up;
administrators have an Account Management workspace.

See [account registration](docs/account-registration.md) for validation, rate
limits, initial password handling, offline evidence and deployment prerequisites.
No email verification is implemented. Hosted restricted-runtime permissions and
proxy-aware abuse controls require separate review before enabling live signup.

## Authentication

`POST /api/auth/login` accepts JSON `{ "email": "student@example.test", "password": "example-password" }`. Email matching follows the existing unique database field (case-sensitive, with surrounding input whitespace removed). Passwords are never trimmed and must fit bcrypt's 72-byte limit.

Successful responses contain `success`, a `token`, `tokenType: "Bearer"`, `expiresIn: 900`, and `user` with only `userId`, `fname`, `lname`, `email`, and `role: { roleId, roleName }`. Incorrect credentials, inactive users, and unsupported stored hashes receive the same generic 401 response. Invalid input receives 400; internal failures receive a generic 500 without raw database errors.

The approved roles are `System Administrator`, `Facility/Maintenance Staff`, and `Faculty / Student Organization Representative`. Login and profile responses retrieve the actual role through the existing `User.role` relationship; authentication does not assign roles or hardcode role names. Test role IDs are fixture values, not production assignments. For example, a representative's profile can contain:

```json
{
    "userId": 7,
    "fname": "Test",
    "lname": "Representative",
    "email": "representative@example.test",
    "role": {
        "roleId": 3,
        "roleName": "Faculty / Student Organization Representative"
    }
}
```

Bodies larger than 8 KB receive 413; unsupported JSON charsets or content encodings receive 415. Error responses omit parser and database details. The server loads `.env` before reading `PORT` and reports listen failures with a generic message and unsuccessful exit status.

Send `Authorization: Bearer <token>` to `GET /api/auth/me`. It returns `{ "success": true, "user": { ... } }` with the same safe profile fields. Tokens use HS256, a fixed issuer/audience, a user ID subject, and a 15-minute lifetime. The reusable `authenticate` middleware returned by `createAuth` validates tokens and reloads the current active user and role. Authentication responses use `Cache-Control: no-store`.

The operator confirmed a successful real System Administrator login against Supabase V2: login HTTP 200, JWT verified, profile HTTP 200, the correct database role, and no password/hash fields in responses. This is operator-reported verification; it was not repeated during the final review. Historical code used bcrypt; `bcryptjs` supports its `$2a$` and `$2b$` hashes in the existing 255-character password column without schema changes. Plaintext and other formats are rejected. Login and profile retrieval create no accounts or role assignments. Automated tests use mocked Prisma reads and real bcrypt/JWT operations.

Keep `JWT_SECRET` private and use HTTPS in deployment. Tokens are bearer credentials and have no individual logout/revocation mechanism in this foundation; rotating the secret invalidates all tokens. Login throttling is still required before public deployment. The dummy password comparison reduces trivial user-existence timing differences but does not guarantee identical timings across stored bcrypt costs. See the upstream [bcrypt documentation](https://github.com/dcodeIO/bcrypt.js) and [JWT documentation](https://github.com/auth0/node-jsonwebtoken).

The previous implementation, historical migrations, and verification tools remain recoverable from branch `backup/pre-clean-rebuild-20261019`, commit `da28eec`. Keep local environment files and database backups private and separate from Git.

## Reservation status lookup (Reservation Management Task 1)

`GET /api/reservation-statuses` permits the three approved application roles through
the existing JWT and database-backed RBAC middleware. It returns HTTP 200 with
`{ "success": true, "reservationStatuses": [...] }`. Each entry contains only the
actual `statusId` and `statusName` selected from ReservationStatus. The query matches
exactly Pending, Approved, Rejected and Cancelled and orders by `statusId` ascending.
IDs are never assumed or generated by this endpoint.

An empty or partially populated lookup returns the available matching rows,
including an empty list. This does not certify that the reservation workflow is
ready for writes. The endpoint never provisions missing statuses or modifies any
records. Query parameters are unsupported and return 400. Responses use
`Cache-Control: no-store`; missing/invalid authentication and inactive/deleted users
receive 401, unsupported roles receive 403, and unexpected database failures receive
a sanitized 500. Tests use injected Prisma mocks with real local HTTP/JWT/RBAC;
they never connect to Supabase. Reservation creation, transitions, procedures and
audit triggers remain outside Task 1.

## Read-only Reservations API (Reservation Management Task 2)

`GET /api/reservations` and `GET /api/reservations/:id` reuse the existing JWT,
active-user and database-role checks. The `System Administrator` role can read all
reservations. `Facility/Maintenance Staff` and
`Faculty / Student Organization Representative` can read only records whose `requestedBy` matches their current
authenticated user ID. Both list and detail queries apply ownership in Prisma;
inaccessible and nonexistent IDs return the same 404 response. Requester IDs,
roles and other client fields cannot override that scope.

Lists return `{ "success": true, "reservations": [...], "pagination": { "page": 1,
"limit": 20, "hasMore": false } }`. Pagination defaults to page 1 and limit 20;
limit must be between 1 and 100, and the database fetches at most limit + 1 scoped rows.
Rows are ordered by the unique `reservationId` ascending. The extra scoped row
determines `hasMore`; no total or other users' counts are returned. Offset pages
may shift if records change between requests.

Only positive decimal page/limit/ID strings without signs, exponents, fractions or
leading zeros are accepted. IDs/pages must fit a PostgreSQL integer; offsets above
2,147,483,647 are rejected. Lists support only page and limit; detail requests
support no query parameters. Invalid values, repeated parameters and unsupported
filters return 400.

Detail responses use `{ "success": true, "reservation": { ... } }`. Both endpoints
select and serialize only `reservationId`, `facilityId`, `requestedBy`, `approvedBy`,
`statusId`, `purpose`, `startDatetime`, `endDatetime`, and `createdAt`. Nullable
approvers stay null; Prisma Date values serialize as UTC ISO timestamps. No nested
users or equipment are returned. Responses use `Cache-Control: no-store`, existing
401/403 conventions, and sanitized 500 errors.

Tests use injected read-only Prisma mocks and local HTTP/JWT requests, asserting
the actual ownership predicates, bounded pagination, projection and ordering.
Neither endpoint creates reservations or statuses or exposes transition/write
operations. Live database access, procedures and audit triggers remain outside
Task 2. Task 1's independent status lookup remains unchanged.

## Reservation input validation (Reservation Management Task 3)

`validateReservationCreation` from `src/reservation-validation.js` is a pure helper
for future creation code. It accepts only facilityId, purpose, startDatetime and
endDatetime, and returns normalized data or fixed field/error codes. It trims
purpose and counts Unicode code points; strict timezone-aware timestamps normalize
to UTC ISO strings with millisecond precision. Excess precision is rejected without
rounding. See the [validation contract](docs/reservation-input-validation.md) for
the exact timestamp profile, error codes and deferred checks. It performs no
database access, current-time checks or booking-policy enforcement, and is not
an HTTP handler itself. Current reservation creation reuses it as described below;
existing GET behavior remains unchanged.

## Reservation transaction context (Reservation Management Task 4)

`createReservationTransaction({ getPrisma })` provides an internal gateway for
future authenticated reservation operations. It validates the backend actor ID,
sets transaction-local PostgreSQL actor context using bound SQL, and then runs
the callback on the same Serializable transaction client. It uses existing
transaction limits and sanitized errors, without automatic retries. See the
[gateway contract](docs/reservation-transaction-context.md) for trusted `req.user`
usage, authorization requirements, uncertain-outcome handling and required future
isolated-PostgreSQL tests. No route, reservation mutation, procedure or trigger is
introduced; existing GET endpoints remain unchanged.

## Reservation workflow (Tasks 5–11)

The facility-only workflow adds POST `/api/reservations` and POST
`/api/reservations/:id/approve`, `/reject`, and `/cancel`. Existing JWT, active-user
checks and database-backed RBAC remain in use. Four actual PostgreSQL procedures,
an allowlisted audit trigger and a facility closure guard are supplied as six
additive migrations. They preserve the professor-approved schema and original
migration. No general editing, rescheduling, reopening, hard deletion or equipment
allocation endpoint is added.

**PROVISIONAL policies require final instructor/operator approval before deployment:**
future dates, eight elapsed hours maximum, both endpoints within 90 days, no buffers,
creation conflict checks, administrator cancellation override, and active/future
Approved bookings blocking facility closure. See the
[workflow and deployment contract](docs/reservation-workflow.md) for exact rules,
privileges, request/response structures, recovery limitations and prerequisites.

`npm run quality` remains database-free and never migrates or provisions anything.
For opt-in disposable PostgreSQL 17 verification, set `IM101_TEST_PG_BIN` to trusted
local binaries and run `npm run test:postgres`. The harness creates its own loopback
cluster, generated credentials and fixture data; it never selects the normal
DATABASE_URL, an installed service, a remote database or Supabase. CI runs the
database-free quality workflow; no deployment or migration workflow was added.

Backend connections explicitly use UTC startup options because the pinned adapter
requires UTC for accurate timestamptz decoding. URL-level startup `options` overrides
are refused for operator review. Existing TLS and V2 operator safeguards remain.

## Role checks

`createAuth({ getPrisma, jwtSecret })` also returns `requireRoles(allowedRoles)`. Supply a nonempty array of exact role names when defining a route. It authenticates the bearer token and reloads the current active user and role before checking permission, so it can be mounted directly without a separate `authenticate` call. It returns 401 for failed authentication and 403 with a generic `Access denied.` message when the database role is not permitted. Database failures flow to the app's existing safe error handler.

The middleware uses `roleName`, never a fixed role ID or role sent in a token, header, body, or query string. Multiple allowed names are supported, with no implicit administrator bypass. Invalid configuration throws during route setup, and the middleware copies the allowed list so later array changes do not alter permissions. Tests use isolated Express routes and mocked database reads; no production demonstration routes or business permission matrix are added. Future modules must explicitly choose their permitted roles and enforce any record-level ownership rules.

### Local database connection

The backend connects to Supabase PostgreSQL through Prisma.

Before running the backend on Windows, configure the database connection in your private `.env` file.

If Node.js requires the Supabase CA certificate, download the certificate from the Supabase dashboard, save it outside the repository, and set the environment variable in PowerShell:

```powershell
$env:NODE_EXTRA_CA_CERTS = "$HOME\Documents\IM101-Backups\supabase-v2-ca.crt"
```

Then verify the database connection:

```powershell
npm.cmd run db:check
```

Never commit `.env`, database passwords, or private certificate files. Keep TLS certificate verification enabled.

## Initial account provisioning (operator only)

This local command is not wired into the server, installation, or migrations. Automated tests use mocks or invoke the CLI without confirmation, which prevents database access. It exposes no registration API. After reviewing and approving the change, an operator can initialize the exact three approved roles and the first System Administrator. Nothing is created until the operator runs the command and types its exact confirmation phrase in an interactive terminal. Piped input and `--yes` are not supported.

First run `npm ci` and `npm run prisma:generate`. Privately verify that `DATABASE_URL` targets the intended Supabase V2 database, uses `sslmode=verify-full`, and has the required read/insert permissions. Set `NODE_EXTRA_CA_CERTS` to the external certificate documented above before starting Node; do not disable TLS verification. This command deliberately refuses weaker SSL modes. No migration or database reset is needed.

The modes are:

- `npm.cmd run provision:initial -- roles`: type `INITIALIZE ROLES` to upsert the approved role names. Existing roles keep their IDs and values, including unrelated roles. Repeating this mode does not create duplicate roles.
- `npm.cmd run provision:initial -- admin`: type `CREATE FIRST ADMINISTRATOR` to ensure those roles and create one active administrator. This mode also initializes roles, so running the roles mode first is optional. It rejects an existing exact email or any existing System Administrator, including an inactive one; it never promotes an existing account, resets a password, or replaces records.

For the first real account, run the following yourself in a trusted, non-recorded PowerShell terminal after approval. Values come from prompts, not command arguments or checked-in files. Use a strong unique password with at least 15 characters and at most 72 UTF-8 bytes. Names are limited to 60 characters and email to 150; surrounding name/email whitespace is removed, passwords are preserved, and email matching stays case-sensitive like login.

```powershell
$env:PROVISION_ADMIN_EMAIL = Read-Host "Administrator email"
$env:PROVISION_ADMIN_FIRST_NAME = Read-Host "First name"
$env:PROVISION_ADMIN_LAST_NAME = Read-Host "Last name"
$provisionPassword = Read-Host "Administrator password" -AsSecureString
$provisionPointer = [IntPtr]::Zero
try {
    $provisionPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($provisionPassword)
    $env:PROVISION_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($provisionPointer)
    npm.cmd run provision:initial -- admin
    # At the command's prompt, type: CREATE FIRST ADMINISTRATOR
} finally {
    if ($provisionPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($provisionPointer)
    }
    $provisionPassword.Dispose()
    Remove-Item Env:PROVISION_ADMIN_PASSWORD, Env:PROVISION_ADMIN_EMAIL, Env:PROVISION_ADMIN_FIRST_NAME, Env:PROVISION_ADMIN_LAST_NAME -ErrorAction SilentlyContinue
}
```

The password exists briefly in the operator process environment and child process memory; use a trusted local session and never echo or persist these variables. The command stores only a bcrypt hash with cost 12 and prints sanitized status messages, never supplied credentials, hashes, connection strings, or raw database errors. Exit code 0 means completion; 1 means refusal or failure. Input and confirmation are checked before the database client is opened. Malformed Unicode is rejected; names and emails also reject control characters. Exactly one `sslmode=verify-full` parameter is required, preventing conflicting duplicate TLS settings.

Role upserts and administrator creation share one Serializable transaction with a 10-second acquisition limit and a 30-second transaction limit; the database adapter also bounds connection/query waits to 10 seconds. Password hashing happens before the transaction starts. Failed transactions roll back their record changes, although PostgreSQL sequences can retain gaps. Concurrent initial-administrator attempts use the same Serializable existence check and insertion; a conflicting attempt must abort rather than create a second administrator. This protects cooperating provisioning transactions, not arbitrary external writes or future administrator-management code. Serialization conflicts are reported without automatic retries; review state before rerunning. If cleanup or connection failure makes the outcome uncertain, verify the database state before retrying. Tests cover simulated concurrent commit conflicts and real Prisma queries through an isolated adapter; actual PostgreSQL write concurrency remains unverified. Existing approved roles keep their IDs and values when creating the first administrator; role initialization need not be rerun first.

### Test a real login after provisioning

From the repository root, run this yourself in a fresh, trusted, non-recorded **PowerShell 7.6.7** terminal (`pwsh` on PATH) with Node.js 24 and dependencies installed:

```powershell
npm.cmd run verify:admin
```

The script uses the trusted CA at `$HOME\Documents\IM101-Backups\supabase-v2-ca.crt` by default. If yours is elsewhere, set `NODE_EXTRA_CA_CERTS` to that private certificate path first. Ensure the private `.env` (or process environment) contains the intended V2 `DATABASE_URL`. At the prompts, enter the V2 project reference obtained independently from its dashboard, then the existing administrator email and password using the private credential prompt. Do not run this through Codex or share credentials, tokens, raw responses, or errors.

`scripts/verify-admin-login.ps1` retains the reviewed verification procedure (PowerShell 7.3+ compatible). It validates the effective Supabase V2 host/user, exactly one `sslmode=verify-full`, and TLS verification before starting the existing backend on a temporary loopback port. It sends exactly one login request and one profile request, verifies the JWT signature, issuer, audience, subject and 15-minute lifetime, checks the System Administrator database role and exact response fields, then stops the server and disconnects automatically. The handlers perform database reads only; no provisioning, schema changes, or record writes occur. Credentials travel through standard input, never command arguments or files. The random JWT secret exists only in the child process and is never written to `.env`.

Exit code 0 means PASS; 1 means refusal or failure. Report only PASS or the sanitized failure stage. A configuration failure requires checking private V2 settings, not disabling TLS. Close the temporary terminal afterward: clearing variables does not guarantee erasure of immutable strings. HTTP is used only on loopback; use HTTPS for non-local deployment.

`/api/auth/me` verifies authentication and reloads the database role. Buildings endpoints now apply the read/write permissions below using the same middleware. Database-free tests cover all approved roles, denials, spoofed claims, and role changes; Buildings permissions have not been tested against live Supabase records. Public deployment still requires login throttling; this foundation has no individual token logout/revocation.

### Existing administrator password recovery

For a forgotten password, follow the [local administrator recovery procedure](docs/administrator-password-recovery.md). `npm.cmd run reset:admin-password` privately prompts for a new password twice and requires an exact confirmation naming the email and V2 project before database access. It refuses missing, inactive or non-administrator accounts and updates only the selected existing user's password hash in a serializable transaction. It does not create administrators, assign roles, expose a public reset API, or invalidate existing JWTs. Failures print sanitized stages; uncertain commit or cleanup outcomes require private verification before retrying. Recovery is manual and is not part of login, installation, tests or migrations.

### Phase 6 dependency security review

The lockfile updates `body-parser` from 2.3.0 to 2.4.0 (compressed-body denial of service) and development-only `fast-uri` from 3.1.8 to 3.1.9 (URI parsing/normalization advisories). The parser's required `qs` dependency also moves from 6.16.0 to 6.16.1. These updates fit the existing dependency ranges; Express and Prisma versions and direct dependency declarations are unchanged. See the upstream [body-parser advisory](https://github.com/advisories/GHSA-27r3-jxmh-p828) and [fast-uri advisory](https://github.com/advisories/GHSA-wjr9-j795-jxcr). Use `npm ci` to install the reviewed lockfile and `npm run audit` to check current advisories.

## Buildings API (Phase 7)

Every Buildings request requires `Authorization: Bearer <token>`. JWT verification reloads the current active user and their actual database role before checking permissions. Request bodies, headers and token role claims cannot grant permissions.

| Endpoint                             | Permission               | Success                  |
| ------------------------------------ | ------------------------ | ------------------------ |
| `GET /api/buildings?page=1&limit=20` | All three approved roles | 200: paginated buildings |
| `GET /api/buildings/:id`             | All three approved roles | 200: one building        |
| `POST /api/buildings`                | System Administrator     | 201: created building    |
| `PUT /api/buildings/:id`             | System Administrator     | 200: updated building    |
| `DELETE /api/buildings/:id`          | System Administrator     | 200: deleted building    |

The read roles are `System Administrator`, `Facility/Maintenance Staff`, and `Faculty / Student Organization Representative`. Other roles receive 403. Missing/invalid tokens and inactive/deleted users receive 401. Unexpected database errors return a generic 500 without driver details.

Creation requires `buildingName` and `floorCount`; `locationNote` is optional. For example:

```json
{
    "buildingName": "Science Building",
    "floorCount": 3,
    "locationNote": "Near the main gate"
}
```

Building names are trimmed, nonempty strings of at most 100 Unicode characters. Floor count must be a JSON integer from 1 to 32,767 (positive values within the approved PostgreSQL SmallInt range). Location notes are trimmed strings of at most 150 Unicode characters or `null`; empty notes are allowed, and omission on creation stores `null`. Text rejects malformed Unicode, NUL and other control characters. IDs must be positive decimal integers up to 2,147,483,647; signs, decimals, exponents and leading zeros are rejected. Invalid inputs receive 400. Unknown writable fields, including IDs, roles and nested facilities, are rejected.

`PUT` accepts a nonempty set of supplied fields, validates each one, and preserves omitted fields. For example, `{ "floorCount": 4 }` changes only the floor count, and `{ "locationNote": null }` clears the note. It never creates a missing building. Create, get, update and delete successes return `{ "success": true, "building": { "buildingId", "buildingName", "floorCount", "locationNote" } }` (field names shown here as an outline). These are the only selected Building fields.

List responses contain `success`, `buildings` and `pagination: { page, limit, hasMore }`. Page defaults to 1; limit defaults to 20 and is capped at 100. Both must be positive decimal integers. Duplicate or unknown query parameters and offsets exceeding 2,147,483,647 are rejected with 400. Results are ordered by `buildingId` ascending. The API fetches one extra row to calculate `hasMore`; it does not issue a total-count query. A page beyond available rows returns an empty array. Offset pagination can shift between requests when buildings are added or deleted.

Missing buildings return 404. PostgreSQL's existing unique building-name constraint is the final check for duplicates, including concurrent requests, and produces a safe 409 response. Matching follows the existing database constraint and is case-sensitive. Deletion uses a single Prisma delete and relies on the approved `NO ACTION` foreign key: any referencing facility blocks the delete with 409. This also protects against a concurrent facility insertion. The API never deletes facilities, uses nested deletes, or changes schema/migrations. Updates that supply `floorCount` now use a Serializable transaction: if any facility in the building has a floor above the proposed count, the entire update returns 409 without changing the building or facilities. A count equal to the highest facility floor is allowed. Other Building writes remain single atomic Prisma statements; duplicate/existence prechecks are unnecessary.

The request path is: Express parses JSON → existing JWT middleware verifies the token and reloads the active user → `requireRoles` checks the stored role → Buildings validates the ID/query/body → Prisma builds the database query → PostgreSQL enforces unique and foreign-key constraints → Express returns a safe JSON result. Automated tests inject mocked Prisma responses while exercising real local HTTP, JWT and RBAC code; they insert no Supabase test records. Additional mocks simulate simultaneous duplicate creates and a facility arriving during deletion, and verify expired-token rejection and that signed role claims cannot grant write access. These mocks verify API behavior, not live PostgreSQL concurrency. Facilities CRUD is described below; live Buildings verification remains separate future work. The shared 8 KB JSON body limit and existing 413/415 parser responses still apply.

## Facilities API (Phase 7)

Facilities belong to one existing Building and one existing FacilityType. A building can have many facilities. The API uses only the eight approved Facility fields: `facilityId`, `buildingId`, `facilityTypeId`, `facilityName`, `floorNumber`, `capacity`, `status`, and `createdAt`. It creates no new tables, fields, facility types, or seed records.

| Endpoint                     | Permission               | Success               |
| ---------------------------- | ------------------------ | --------------------- |
| `GET /api/facilities`        | All three approved roles | 200: facility list    |
| `GET /api/facilities/:id`    | All three approved roles | 200: one facility     |
| `POST /api/facilities`       | System Administrator     | 201: created facility |
| `PUT /api/facilities/:id`    | System Administrator     | 200: updated facility |
| `DELETE /api/facilities/:id` | System Administrator     | 200: deleted facility |

The three read roles are System Administrator, Facility/Maintenance Staff, and Faculty / Student Organization Representative. Every request uses the same bearer JWT and database-backed `requireRoles` checks as Buildings. Invalid/expired tokens and inactive/deleted users receive 401; unapproved roles or non-administrator writes receive 403. Roles supplied in tokens, headers, queries or bodies cannot grant access. Unexpected database failures return a generic 500 without credentials or raw driver details.

POST requires the five fields below; the IDs are examples only and must refer to records that actually exist:

```json
{
    "buildingId": 1,
    "facilityTypeId": 1,
    "facilityName": "Lecture Room 201",
    "floorNumber": 2,
    "capacity": 40
}
```

`status` is optional on creation: omitting it uses the database default `Available`. `createdAt` uses the database's current-time default, and `facilityId` is generated by the database. Neither field is writable. Unknown fields and nested writes such as `building`, `equipment` or `reservations` are rejected with 400. Single-record successes contain `success` and `facility`, with only the eight approved scalar fields; `createdAt` is serialized as an ISO timestamp.

Validation and explicit business choices:

- IDs and capacity are JSON integers from 1 to 2,147,483,647. URL IDs and filter IDs use the same positive decimal syntax as Buildings, without signs, exponents, decimals or leading zeros.
- Names are nonempty trimmed strings of at most 100 Unicode characters. Status is a nonempty trimmed string of at most 20 characters. Both reject malformed Unicode, NUL and control characters. The schema has no status enum or lookup, so this API accepts custom status text and defines no status-transition or reservation-availability rules.
- Floor numbering is **one-based**: the resulting floor must be between 1 and the selected building's `floorCount`, and fit PostgreSQL SmallInt (maximum 32,767). This is an API business rule; the schema itself also permits zero/negative SmallInt values. Ground-floor-zero and basement numbering are not supported by this choice.
- Capacity must be positive; zero-capacity facilities are not supported by this choice even though the schema stores an ordinary integer.
- Building and facility-type references are checked on both create and update. Missing references return 400. An empty facility-type lookup therefore prevents creation; the API does not assume types exist or silently create them. Populating approved lookup data requires a separate authorized task.

PUT accepts a nonempty partial object, validates supplied values, and preserves omitted fields. It loads the existing facility and checks the resulting building/type/floor together. For example, moving a room from floor 3 to a building with only one floor requires sending both the new `buildingId` and `floorNumber: 1`. Missing facilities return 404; updates never upsert. Create/update checks and writes share a Serializable Prisma transaction with bounded acquisition/execution waits, so partial updates are checked against a consistent snapshot. Serialization/write conflicts return 409 without automatic retry.

The existing unique constraint is `(buildingId, facilityName, floorNumber)`: the same name on the same floor of the same building produces 409, even with a different facility type. The name can appear on another floor or in another building. Uniqueness remains database-enforced and case-sensitive. Foreign-key conflicts during writes (such as a parent removed after validation) return a sanitized 409.

Listing accepts optional `buildingId` and `facilityTypeId` filters, combined with AND when both are provided. For example: `GET /api/facilities?buildingId=1&facilityTypeId=2&page=1&limit=20`. Pagination follows Buildings: page 1 and limit 20 by default, limit capped at 100, deterministic `facilityId` ascending order, and `pagination: { page, limit, hasMore }`. One extra row determines `hasMore`; no total-count query is made. Repeated/unknown query parameters, invalid filters and excessive offsets return 400. A valid filter with no matching records returns an empty list. Offset pagination may shift between requests as data changes.

Deletion issues only one Prisma facility delete. Existing `NO ACTION` foreign keys block deletion if equipment, reservations, maintenance requests or staff assignments reference the facility, returning 409. This also covers records inserted concurrently; the API never cascade-deletes or unlinks dependent records. No preliminary count is used to authorize deletion.

Tests use isolated Prisma mocks and real local Express/JWT/RBAC requests. They cover CRUD, filters, pagination, references (including empty lookups), merged partial updates, uniqueness, dependencies, late foreign-key conflicts, serialization rollback, and safe failures. Unexpected Prisma codes and private error metadata are tested to ensure only generic 500 messages are returned. No live Supabase records are read or changed. Live database/concurrency verification remains unperformed. Existing 8 KB body limits, login-throttling requirements, and lack of individual JWT revocation remain unchanged.

### Building/facility floor consistency

The two APIs cooperate to preserve `facility.floorNumber <= building.floorCount`. Facilities create/update reads the selected building's floor count and validates the resulting facility before writing. Buildings updates that supply `floorCount` read a predicate over facilities in that building (`floorNumber > proposed floorCount`) before writing; any match produces 409. Both checks and writes use Serializable transactions with a 10-second acquisition limit and 15-second execution limit. Non-floor Buildings edits do not need this extra transaction.

This handles the race where a building shrinks while another request creates a high-floor facility, raises its floor, or moves it into that building. If the writes cannot be committed in a valid serial order, PostgreSQL's Serializable isolation detects the conflict and Prisma reports `P2034`. Either route returns a sanitized 409, with no automatic retry. Reload the current records before a new operator-initiated attempt. See [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-SERIALIZABLE).

Mock-only regression tests cover blocked and allowed floor-count changes, rollback on guard-query and commit failures, and overlapping create/move-versus-shrink requests with either transaction chosen as the conflict loser. The overlap tests deliberately inject `P2034`; they verify route behavior and isolation configuration, not PostgreSQL's internal conflict detector.

This is an application safeguard for these cooperating routes, not a new database constraint. Every future writer of building floor counts or facility building/floor values must use the same validation and Serializable protocol. Direct SQL, dashboard edits, scripts, or other writers that bypass it can still introduce inconsistent floors, and pre-existing inconsistencies are not automatically repaired. The approved foreign keys enforce references but do not compare floor numbers to parent floor counts. Universal enforcement for arbitrary database writers would require additional database-side enforcement, which is outside this schema-preserving task.

## Lookup preparation and controlled live CRUD (Phase 7 Task 4)

See the [operator runbook](docs/lookup-and-live-crud.md) for suggested lookup values,
offline mock tests, project/TLS guards, separate explicit approvals, private
receipts and the disposable Buildings/Facilities/Equipment test sequence.
`npm run provision:lookups` is an offline preview. Live lookup writes and live
CRUD verification are separate manual operator actions; quality checks never
launch them. The approved DBML, Prisma schema and migrations are unchanged.

## Equipment API (Phase 7)

Equipment uses the approved fields only: `equipmentId`, `categoryId`, `homeFacilityId`, `equipmentName`, `serialNumber`, `totalQuantity`, `availableQuantity`, `conditionStatus`, and `createdAt`. Each record requires an existing EquipmentCategory and can optionally refer to a home Facility. Neither lookup records nor facilities are created automatically; an empty category lookup prevents creation with a safe 400 response.

| Endpoint                    | Permission               | Success             |
| --------------------------- | ------------------------ | ------------------- |
| `GET /api/equipment`        | All three approved roles | 200: list           |
| `GET /api/equipment/:id`    | All three approved roles | 200: one record     |
| `POST /api/equipment`       | System Administrator     | 201: created record |
| `PUT /api/equipment/:id`    | System Administrator     | 200: updated record |
| `DELETE /api/equipment/:id` | System Administrator     | 200: deleted record |

All endpoints reuse bearer JWT verification, current active-user lookup and database-backed `requireRoles`. The read roles are System Administrator, Facility/Maintenance Staff, and Faculty / Student Organization Representative. Missing/invalid/expired tokens and inactive/deleted users receive 401; disallowed roles receive 403. Client-supplied roles in valid token claims, headers, queries or bodies cannot grant permissions.

Create example (the category ID is illustrative and must actually exist):

```json
{
    "categoryId": 1,
    "homeFacilityId": null,
    "equipmentName": "Folding chairs",
    "serialNumber": null,
    "totalQuantity": 20,
    "availableQuantity": 20
}
```

Creation requires `categoryId`, `equipmentName`, `totalQuantity` and `availableQuantity`. Omitted `homeFacilityId` and `serialNumber` store `null`; either can be explicitly cleared to `null` on update. Omitted `conditionStatus` uses the database default `Good`. The ID and creation timestamp are database-generated and cannot be written. Single-record responses contain `success` and `equipment` (one object); list responses contain `success`, `equipment` (an array) and `pagination`. Only the nine approved scalar fields are selected, with `createdAt` serialized as an ISO timestamp.

Names are nonempty trimmed strings up to 100 Unicode characters; serial numbers are `null` or nonempty trimmed strings up to 60; condition text is nonempty and limited to 20. Text rejects malformed Unicode, NUL and control characters. The schema defines no condition enum or special serial format, so the API accepts custom condition text and does not assume a serial number implies a single-unit record. Non-null serial numbers use the database's case-sensitive unique constraint; duplicates return 409. Multiple null serials are allowed. Condition text is descriptive metadata and does not automatically change stock counts or implement maintenance/checkout eligibility.

IDs are positive PostgreSQL-compatible integers up to 2,147,483,647. Quantities must be JSON integers from 0 to 2,147,483,647 and must satisfy `availableQuantity <= totalQuantity`. Unknown fields, generated IDs/timestamps, nested writes, wrong types and invalid inputs receive 400. Missing records return 404. Missing category/facility references return 400; foreign-key conflicts arising later return 409. PUT accepts nonempty partial updates and never upserts. Unexpected Prisma errors return a generic 500; raw messages, private metadata and configuration are withheld.

Listing supports `categoryId`, `homeFacilityId` and exact, case-sensitive `conditionStatus` filters, combined with AND. `homeFacilityId=null` selects unassigned equipment. Example: `GET /api/equipment?categoryId=1&homeFacilityId=null&conditionStatus=Good&page=1&limit=20`. Pagination defaults to page 1 and limit 20, with limit capped at 100, `equipmentId` ascending ordering, and `pagination: { page, limit, hasMore }`. One extra row determines `hasMore`; there is no total count. URL IDs/filter IDs/page/limit use positive decimal syntax without signs, exponents, decimals or leading zeros. Repeated or unknown query parameters, malformed filters and offsets above 2,147,483,647 receive 400. A valid filter with no matches returns an empty list. Offset pages may shift as rows change.

### Conservative inventory policy

This API manages inventory records; it does not implement borrowing, checkout, returns, reservations or maintenance workflows. To avoid quietly treating CRUD as those workflows:

- **New stock starts fully available.** Creation requires equal total and available quantities (including zero); a difference returns 400. Initial unavailable stock requires a separately designed inventory/reconciliation workflow.
- **Stock adjustments preserve the existing unavailable amount.** On update, `unavailable = current.totalQuantity - current.availableQuantity`. If a new total is supplied without availability, the API derives `newAvailable = newTotal - unavailable`. For example, a valid legacy record with total 10 and available 7 changes to total 12 and available 9. This preserves the gap; it does not assume why those three units are unavailable.
- If availability is supplied explicitly, it must equal that derived value. A direct availability change receives 409 because checkout/return is outside CRUD. A total below unavailable stock receives 400. Inconsistent stored counts receive 409 rather than being silently repaired.
- **Any loan-item, reservation-item or equipment maintenance reference blocks actual quantity changes with 409**, even historical/closed references. The approved schema alone does not establish active lifecycle rules, so this API does not infer them from status text or sum those records. Metadata and quantity no-ops remain editable when counts are valid. This fail-closed policy can block legitimate stock corrections indefinitely while history is retained, even after all work is completed; it does not automatically expire. Stock adjustments on referenced records need a separately reviewed, authorized reconciliation/inventory workflow with defined lifecycle and accounting rules. Do not delete/unlink history or relabel statuses to bypass this safeguard. No force/override flag or stock-correction bypass is provided here.
- **Deletion requires fully available, consistent stock** and then issues only one equipment delete. Existing `NO ACTION` foreign keys reject any referencing LoanItem, ReservationEquipment or MaintenanceRequest with 409, including references arriving late. The API never cascades, deletes or unlinks those records.

All Equipment writes use a Serializable Prisma transaction with 10-second acquisition and 15-second execution limits. Updates read the current equipment, validate merged quantities and references, inspect dependent records when quantities actually change, and write within that transaction. Deletion reads the inventory state before the database-enforced delete. Concurrent write/serialization conflicts (`P2034`) return sanitized 409 responses without automatic retries; reload current records before a new attempt. The total is an absolute replacement value, not a delta command.

These inventory rules are application-level safeguards for cooperating writers. The unchanged schema has unique and foreign-key constraints, but no nonnegative/range or cross-table stock-accounting constraints. Future loan/reservation/maintenance/inventory workflows must coordinate reference changes and atomic stock changes in the same Serializable protocol, validate available stock, and define lifecycle, reservation and condition rules before use. A writer that inserts/deletes dependent rows or edits quantities outside that protocol can bypass the policy. The API cannot detect stale sequential administrator edits without an expected-version contract, reconcile historical stock, or guarantee a failed request means no commit occurred if acknowledgement was lost. Existing inconsistent data is not repaired automatically. These limitations must be addressed before those workflows are enabled; no new schema fields, triggers, lookup tables or migration are introduced here.

Equipment tests use isolated Prisma snapshots and real local HTTP/JWT/RBAC requests. They cover CRUD, optional references, filters/pagination, roles/tokens, input boundaries, serial uniqueness, inventory rules, dependency conflicts, safe errors and transaction rollback. Review regressions include exact unavailable-stock reductions, rollback of combined stock/serial edits, completed-history blocking at zero stock, late home-facility removal, and unexpected commit failures. The commit-failure mock tests a rollback outcome only; a lost acknowledgement after a real commit remains an uncertain outcome requiring verification before retrying. Overlapping quantity updates test either simulated commit winner using an injected serialization conflict; they do not reproduce PostgreSQL's conflict detector or verify live concurrency. No live Supabase records are accessed. Existing authentication throttling/revocation limits and the shared 8 KB body limit remain unchanged.
