# Registration production-readiness review

Reviewed target: IM101-Campus-Facility-V2 (`mqrucrjlikwrxldweqwo`).
The hosted inspection used the existing operator connection, project identity
validation, a trusted CA, hostname verification and a READ ONLY transaction.
No hosted grants, passwords, accounts, schema or settings were changed.

## Hosted findings

The restricted `im101_render_app` login currently has:

- SELECT on `users.user_id`, `role_id`, `fname`, `lname`, `email`,
  `password_hash` and `is_active`.
- SELECT on the two `roles` columns: `role_id` and `role_name`. A table-level
  SELECT check alone returns false; the column-level checks are true.
- public-schema USAGE, but no INSERT or UPDATE on any users column, no users
  DELETE, and no users sequence USAGE or UPDATE.
- No audit-table access, superuser, role/database creation or BYPASSRLS.
  Existing memberships remain the two reviewed runtime roles.

The users/roles tables and users sequence are owned by postgres; the account
tables have neither RLS nor forced RLS enabled. This review leaves those settings
unchanged. The proposal relies on private database grants and backend RBAC, not
public Data API access or newly introduced RLS policies.

The inspected account tables/sequence have no PUBLIC object grants. Effective
checks for anon/authenticated user-column, destructive and sequence privileges
were false. Baseline counts: 4 users, 3 buildings, 8 facilities, 10 equipment and
10 completed migrations. No individual hosted user records or hashes were
printed. This review did not change or independently reconfigure the Data API.

## Exact permission proposal — APPROVAL REQUIRED, NOT APPLIED

For the current Prisma implementation, the only additional grants required are:

```sql
BEGIN;
GRANT INSERT (
    role_id, fname, lname, email, password_hash, is_active, created_at, updated_at
) ON TABLE public.users TO im101_render_app;
GRANT USAGE ON SEQUENCE public.users_user_id_seq TO im101_render_app;
COMMIT;
```

This is a review proposal, not an automatically applied migration or deployment
script. It must not be executed until separately approved against the correct
project and a fresh read-only privilege preflight. PostgreSQL column grants and
sequence permissions are separate privileges; see the
[PostgreSQL 17 GRANT documentation](https://www.postgresql.org/docs/17/sql-grant.html).

Do not grant ALL, table-wide INSERT, user UPDATE/DELETE, INSERT(user_id),
INSERT(id_number/contact_number), SELECT on more user columns, sequence UPDATE,
schema CREATE, owner membership, GRANT OPTION, or permissions to PUBLIC/anon/
authenticated. Existing runtime auth/catalog/audit permissions stay unchanged.
No schema or migration changes are needed for this option.

Why timestamps are included: an isolated test captured only the SQL structure
(never parameters) emitted by the installed Prisma 7.10.1 adapter and asserted
that its INSERT includes exactly those eight columns. Prisma supplies the
default timestamp values even though HTTP clients cannot provide them. The
restricted test login could then register, log in and create Staff as an active
Administrator, while private columns, user UPDATE/DELETE, audit DML/reads and
sequence setval remained denied.

These grants are the minimum database capabilities for the current code, not a
database-enforced role-selection boundary. A compromised runtime credential with
INSERT(role_id) could insert an Administrator directly. HTTP validation prevents
this through the application, but database permissions do not constrain the new
role ID or is_active value. Approval must explicitly accept that trusted-backend
boundary. If it is unacceptable, do not apply the proposal: separately design and
review fixed-role database routines with independent actor checks, restricted
execution grants and appropriate ownership. That alternative is not implemented
by this patch and needs its own additive migration review.

## Render proxy and abuse control: deployment blocker

Express currently has default `trust proxy = false`. The signup limiter uses
`req.ip`, not raw forwarding headers. Forged X-Forwarded-For values cannot change
the key; offline HTTP tests verify this. No blanket proxy trust was introduced.

This prevents header spoofing but does not establish per-visitor limiting on
Render: the observed address can be a shared proxy. A visitor could consume a
proxy's ten hourly signup attempts and deny other visitors using that bucket.
Different proxies could also have separate buckets. The actual live chain and
header sanitization were not inspected through a Render shell/log session.
Therefore public per-client rate limiting on Render is NOT VERIFIED and must be
resolved before enabling live signup.

Render documents Cloudflare/load-balancer forwarding and recommends a shared
store for multiple instances in its
[application abuse guidance](https://render.com/articles/how-render-handles-ddos-attacks).
That guidance does not prove a fixed hop count for this particular service.
[Express proxy guidance](https://expressjs.com/en/guide/behind-proxies/) requires
matching trust configuration to the actual network topology and warns against
accepting attacker-supplied forwarded values.

Shortest safe resolution:

1. Inspect the service's inbound network paths privately, including private
   networking/custom domains. Obtain provider-supported trusted proxy boundaries
   and confirm which forwarded entries are appended or overwritten.
2. Implement a narrowly allowlisted proxy-trust strategy or use a reviewed edge
   limiter. Do not set trust proxy true, assume a numeric hop count, trust all
   private ranges, or select the leftmost forwarded value without that evidence.
3. Verify two independent clients obtain separate keys and an injected forwarded
   address cannot alter those keys. Include missing/malformed/multiple headers,
   IPv4-mapped IPv6, IPv6 subnet aggregation and alternate inbound paths. Do not
   expose a public diagnostic endpoint or publish visitor addresses.
4. For multiple instances or durable limits across restarts, add a reviewed
   shared store/edge control before rollout. Current bounded memory buckets
   reset on restart; deployment does not claim durable distributed protection.

The current ten-per-hour public limit and twenty-per-hour verified-admin limit
apply before costly hashing. This patch does not add login brute-force limiting.
The existing 8 KB request limit is preserved.

## Application review

- Only the five documented account fields are accepted; privileged and unknown
  fields are rejected before database access. Required roles are selected by
  exact canonical name in a Serializable transaction; no hardcoded role IDs.
- Names have a 60-code-point limit. Emails are validated, lowercased for new
  accounts and checked case-insensitively. Existing addresses are not changed.
  Case-sensitive legacy login behavior is retained and disclosed in the form.
- Passwords retain exact whitespace, require 15 code points, are limited to
  bcrypt's 72 UTF-8 bytes and are hashed with bcryptjs cost 12. A small obvious
  password denylist is not a comprehensive breached-password screening service.
- Staff creation requires the existing JWT/current active database Administrator
  middleware and a transaction-level actor recheck. Public signup always creates
  Representatives, including when a caller supplies an Administrator token.
- Only an explicit safe profile projection is returned, with no hash or password.
  201 follows transaction commit confirmation; failures are sanitized and never
  retried automatically. Real concurrent case-variant signups yielded 201/409
  and exactly one record in the isolated database.
- No email verification, campus-membership proof, invitation service, forced
  initial password change or self-service password recovery is claimed. Staff
  passwords are selected by the Administrator and must be shared privately.

## Mobile and accessibility review

Code and DOM tests confirm label/input associations, appropriate autocomplete,
password visibility states, password hints, announced error/success messages,
disabled pending form controls and duplicate-submission prevention. The form
comes before the dark information panel in DOM/keyboard order. At widths below
650 px the name grid becomes one column and the login container stacks.
Administrator-only navigation and direct-URL UI restrictions are tested; backend
authorization remains authoritative.

Actual desktop/mobile visual, zoom, keyboard and screen-reader acceptance remains
pending because available Computer Use was blocked in the prior verification.
This is a code/DOM review, not a claim of completed real-browser acceptance.

## Evidence and shortest deployment sequence

The existing opt-in PostgreSQL harness creates its own new loopback-only cluster,
never uses normal DATABASE_URL, verifies its identity and removes only that
marked disposable cluster afterwards. All 57 checks passed, including five new
registration checks. The persistent local demo and hosted data are untouched.
These local grants were applied only to an isolated test login, not production.

1. Review the PR and this grant proposal; keep the PR in draft while proxy and
   visual verification remain unresolved. The grayscale redesign is a parent
   commit; its separate PR #30 was confirmed merged during this review.
2. Resolve and test Render client-IP/rate limiting as above. Complete mobile and
   desktop signup/staff creation visual review against an isolated environment.
3. Obtain explicit approval for the grant trust boundary and the two exact
   statements. Take/validate a fresh backup and capture counts/permissions, then
   an authorized operator applies only those approved grants over verified TLS.
4. Verify effective privileges again under the restricted runtime login. Never
   use postgres as the application login or enable the Supabase Data API.
5. Only after separate merge/deployment approval, merge the reviewed release and
   deploy using the existing Node 24 build/start/TLS configuration. No database
   migrations, role provisioning, lookup seeding or password resets are needed.
6. With separately authorized disposable live test identities, verify public
   Representative signup/login, Administrator Staff creation, nonadmin 403,
   privileged-field rejection, duplicate 409 and effective 429 limiting. Check
   existing authentication, reservations/conflicts and management reads. Preserve
   created records and inspect before any retry after an uncertain response.

If deployment is withdrawn, disable the new feature/revert the release before
considering revocation of only the newly approved grants. Never delete accounts,
restore over the live database, or broadly revoke existing workflow privileges.
