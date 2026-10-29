# Core development verification record

Base: `92a99a7` (merged PR #26). Feature: `feat/complete-core-modules-ui`.
These results describe local development, not a live deployment or final instructor
policy approval. No live Supabase connection, migration or data change was performed.

## Executed checks

- Complete root quality suite: PASS. Prisma validation/format, Prettier, 58-file
  syntax check, server/client ESLint and backend tests all succeeded.
- Backend offline tests: 258 passed, zero failed or skipped.
- Frontend component/API tests: 28 passed, zero failed (including unknown/inherited
  hash-route regression cases added during final review).
- Vite production build: PASS; build does not require database access.
- Server dependency audit: zero vulnerabilities at every reported severity.
- Client dependency audit: zero vulnerabilities at every reported severity.
- Native disposable PostgreSQL 17.11: 52 scenario groups passed using independent
  real connections for races. Node 24.14.0 and Prisma/adapter-pg 7.10.1 were used.
- Protected DBML, Prisma schema, original migration and six reservation migrations
  compared against the base: unchanged. Git whitespace checks passed.

## Database evidence

The local harness created its own loopback cluster, generated temporary test-only
credentials, verified its data-directory identity, and replayed the original plus
nine additive migrations. It stopped and removed only its marked disposable cluster.
The application DATABASE_URL was never selected. Lookup and account fixtures existed
only inside that disposable database.

The 52 groups include the existing 35 reservation checks plus core modules:
loan creation/review/return and bounds, two connections contending for the last stock,
maintenance visibility/assignment/progress/resolution and competing completion,
assignment lifecycle and competing active keys, exact audit field allowlists,
actor attribution, audit/log failure rollback, privileged DELETE audit capture,
runtime audit/history privilege denials, missing context refusal, original management
API compatibility, scoped catalogs/overview, and a complete migration replay.

Observed PostgreSQL lock contention establishes more than mocked response filtering.
It does not prove hosted Supabase grants, RLS, connection-pooler behavior or network
configuration. New runtime roles have narrow grants; existing catalog CRUD credentials
remain a trusted backend boundary. No claim is made that a database owner or a holder
of backend credentials is confined to HTTP authorization rules.

## Remaining release work

- Review and approve the provisional policies and dedicated role/grant prerequisites
  in [core workflows](core-workflows.md). Live installation remains blocked pending
  that separate approval and effective hosted permission review.
- Decide the LoanItem composite-key audit convention; item-level audit is deferred.
- Perform operator browser acceptance with approved accounts after an approved
  deployment. Browser preview tooling was unavailable during this run; component tests
  and production build passed, but no visual acceptance pass is claimed.
- Review login throttling, HTTPS, backup/recovery and deployment ordering before public
  exposure. There is no automatic deployment, migration, lookup provisioning, write
  retry, server idempotency key or token refresh mechanism in this feature.
- Large maintenance log histories still need separate pagination; selectors initially
  offer the first 100 records with numeric ID entry for other paginated records.
- Whole-loan returns, pool-wide damaged condition, UTC assignment days and new workflow
  states/visibility are provisional, not professor-approved schema changes.
