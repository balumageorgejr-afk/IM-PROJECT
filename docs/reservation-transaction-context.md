# Reservation transaction gateway (Task 4)

`createReservationTransaction({ getPrisma })` from
`src/reservation-transaction.js` returns
`runReservationTransaction(authenticatedUser, operation)`. Inject the existing
`getPrisma` dependency, as routes already do. The factory does not open a connection.
Task 4 introduced no mutation endpoint. Tasks 6 onward use this helper from the
reservation mutation router; existing GET routes do not set actor context.

## Trusted backend usage

Future route code must first run the existing `requireRoles` middleware, which
verifies the JWT and reloads the active user and current database role. Pass
**only `req.user`** as authenticatedUser, never req.body, req.query, headers,
token claims alone, or a client-selected actor. Do not spread request data into
this profile. The gateway requires an own data-property userId containing an
integer from 1 through 2,147,483,647, without coercion or fallback. It snapshots
the ID before asynchronous work and does not invoke userId getters.

The shape check cannot prove that an object came from authentication. This is an
internal backend interface, not an authentication boundary or an HTTP handler.
Any backend code with database credentials can forge this custom PostgreSQL
setting. The setting is a trusted backend claim, not cryptographic proof of user
identity. Do not expose this factory or transaction client through HTTP.

The future operation callback receives the same Prisma transaction client that
sets actor context. All procedure calls and database operations must use that
client, be awaited, and finish before the callback resolves. Do not use the root
Prisma client, start another transaction, change actor context, retain/return the
transaction client, or start background work. Return only an approved result
projection; the gateway is not a response-field sanitizer. Do not perform external
side effects such as email or network calls inside the transaction.

Existing middleware authorization is still required. Future procedures must
independently verify current database user activity, roles, ownership and allowed
status transitions. Neither a valid actor ID nor Serializable isolation performs
those checks or prevents conflicting bookings without the future conflict reads.

## Transaction configuration and context

Each invocation opens one Prisma interactive `$transaction` using
`isolationLevel: "Serializable"`, `maxWait: 10000` and `timeout: 15000` (milliseconds),
matching Buildings, Facilities and Equipment. Existing adapter pool limits and
connection/query timeouts in `src/db.js` remain unchanged. No second pool, session,
credential, TLS override, grant or access role is introduced.

Before invoking the operation, the helper awaits the tagged-template `$queryRaw`
equivalent of `SELECT set_config('im101.actor_id', $1, true) AS "actorId"`.
Only the validated decimal ID text is bound as a parameter. Setting name, SQL
identifiers and the literal `true` are fixed. The returned setting must match the
expected ID before the operation runs. There is no unsafe raw SQL, session-scoped
setting, persistent connection, manual BEGIN/COMMIT, or context-reset fallback.

PostgreSQL documents that `set_config` with is_local true applies only within the
current transaction. After completion the previous setting is restored; this
helper must not be mixed with code that installs session-scoped actor values.
Future triggers must fail closed for missing/empty/invalid actor context during
normal writes. They must not treat a restored empty custom setting as a valid ID.

The installed Prisma Client and adapter are both 7.10.1. The generated interactive
transaction signature supports these three options. Inspection of the installed
adapter shows pool acquisition of one pg client, BEGIN and isolation setup on that
client, a transaction wrapper using that client, and release during completion.
Prisma's transaction manager owns commit/rollback SQL. These source/API findings
are not a substitute for testing the deployed pooler configuration.

References: [Prisma v7 interactive transactions](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions),
[PostgreSQL configuration functions](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SET).

## Failures and recovery boundaries

Errors have one fixed message and one fixed code, with no original cause,
driver message, metadata, SQL, token, profile or request content. Nothing is logged.
Tasks 6 onward additionally map a fixed allowlist of PostgreSQL refusal SQLSTATEs
and serialization/deadlock conflicts to sanitized RESERVATION_* codes. These codes
support fixed HTTP responses; unknown errors retain only the gateway stage below.

| Code                              | Meaning                                      |
| --------------------------------- | -------------------------------------------- |
| INVALID_TRANSACTION_CONFIGURATION | getPrisma dependency is not a function       |
| INVALID_ACTOR_CONTEXT             | Actor missing or ID invalid; no DB access    |
| INVALID_TRANSACTION_OPERATION     | Callback invalid; no DB access               |
| ACTOR_CONTEXT_FAILED              | Setting failed or acknowledgement mismatched |
| TRANSACTION_CALLBACK_FAILED       | Operation threw or rejected                  |
| TRANSACTION_FAILED                | Acquisition or transaction completion failed |

A setting failure prevents the callback. Callback failures reject the interactive
transaction; Prisma is responsible for attempting rollback. Future Express routes
must allow rejection to reach the existing generic error handler (sanitized HTTP
500), not serialize the error or turn it into success. No business-error mapping
or conflict-specific HTTP response is added in Task 4.

The codes describe the last observed gateway stage, **not a database outcome**.
Rollback itself can fail, and a lost COMMIT acknowledgement can leave an uncertain
outcome even after the operation resolved. No error guarantees that no rows changed.
The gateway never retries, including serialization conflicts and timeouts. Stop
and reconcile through a separately designed read-only recovery/idempotency policy
before a caller attempts another future mutation. Never add a blind HTTP retry.

## Offline verification and required PostgreSQL tests

Mock tests assert validation, bound SQL, literal transaction-local scope, ordering,
same-client use, configuration, acknowledgement checks, sanitization and a single
attempt on failure. Mocks do not prove physical connection pinning, PostgreSQL
rollback, pool isolation, timeout enforcement, or successful serialization.
Existing reservation GET suites remain part of the complete quality suite.

Before any live write feature is authorized, use a separately approved isolated
PostgreSQL instance with the pinned Prisma/adapter versions and representative
pooler configuration to verify:

1. The operation reads its actor and Serializable isolation on the same backend
   connection as initialization.
2. Successful commit, callback failure, SQL failure and timeout have the expected
   row outcomes; actor context does not survive commit or rollback. Test reused
   pool connections (including pool size one), sequential actors, concurrent
   actors, cancellation and connection termination. Check both absent and empty
   custom-setting representations.
3. Transactions without actor setup cannot inherit another actor. No infrastructure
   component installs a persistent actor setting.
4. Serialization conflicts propagate without retries. When booking procedures are
   implemented, two competing approvals cannot both claim the same time slot.
5. Lost responses around COMMIT and rollback failure are handled as uncertain;
   recovery does not duplicate mutations. Future triggers fail without verified
   actor context and their audit records roll back with business writes.

No isolated database or Supabase project is contacted by the mock tests. Procedures,
triggers, status provisioning, permissions changes and migration work are deferred.
