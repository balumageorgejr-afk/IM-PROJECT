# Lookup provisioning: local diagnosis and safe retry

The operator has approved the exact 8 Facility Types and 6 Equipment Categories.
The list is unchanged. This investigation does not authorize or perform another
live attempt. No Supabase connection or database operation was used to diagnose it.

## Findings

The old message cannot identify the cause of either historical attempt. It meant
an exception occurred before the script requested COMMIT, and the connection's
final cleanup did not throw. It does not prove that BEGIN or INSERT was never
requested. Rollback errors were silently swallowed.

In the environment available to this investigation, DATABASE_URL is present in
`.env`; NODE_EXTRA_CA_CERTS is absent from both `.env` and the current process.
NODE_TLS_REJECT_UNAUTHORIZED is also absent; absence of that variable does not
disable Node's default certificate verification. The documented CA file exists,
parses as a CA and is within its certificate date range. Its existence alone does
not configure the lookup script to use it. No trust handshake was attempted.

Thus **missing NODE_EXTRA_CA_CERTS is a concrete candidate** for the first failure:
after valid input and a matching URL, it produces CONFIGURATION/CA_PATH_REQUIRED.
A static call of the shared validator reproduced that code using the locally
configured reference inferred from the URL, without creating a client. That
inferred reference does not independently establish the intended project identity.
The operator's previous PowerShell process may have had different environment
variables, so this is not a proven explanation of that historical attempt.
The administrator verification launcher sets its CA environment temporarily and
restores the previous value; running it previously does not permanently configure
the separate lookup command. The lookup script has no automatic CA-path fallback.

An incomplete phrase would explain the second failure. Full phrases still fail if
they have leading/trailing spaces, different case, extra text, hidden characters,
or a different project reference. Nothing trims or relaxes confirmation.

## Every source of the old generic failure

| Old failure location       | Conditions                                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input validation           | Project reference is not exactly 20 lowercase ASCII letters/digits; confirmation is anything other than the exact full phrase containing that reference.                                                                                             |
| URL parsing                | Missing or malformed DATABASE_URL; invalid percent encoding in username/password.                                                                                                                                                                    |
| URL shape                  | Protocol other than postgres/postgresql, a URL fragment, database path other than /postgres, absent password, explicit port other than 5432, or query-parameter count other than exactly one. Duplicate sslmode or additional parameters fail here.  |
| TLS configuration          | The sole parameter is not sslmode=verify-full, or NODE_TLS_REJECT_UNAUTHORIZED is exactly 0.                                                                                                                                                         |
| V2 identity                | Direct hostname is not db.<entered-reference>.supabase.co with postgres user, or session-pooler host/user do not match the shared validator's allowed pattern and postgres.<entered-reference> user.                                                 |
| Local CA validation        | Missing NODE_EXTRA_CA_CERTS, unreadable/nonexistent file, invalid X.509 content or certificate that is not a CA.                                                                                                                                     |
| Client setup               | pg module/client construction or registering its error listener throws.                                                                                                                                                                              |
| Connection                 | DNS, connection refused/reset/timeout, server availability/limits, authentication, TLS chain/hostname/date verification, or another driver failure. These require a real connection to diagnose and were not attempted here.                         |
| BEGIN                      | Permission, read-only/server/driver failure or lost acknowledgement while starting the Serializable transaction.                                                                                                                                     |
| Either lookup insert phase | Permission, table/column/unique-index mismatch, constraint/length failure, serialization conflict, deadlock, lock/statement/connection timeout, dropped connection, or any other query exception. A returned rowCount other than 0 or 1 also failed. |
| Catch/rollback             | An earlier failure above still produced the same message even when ROLLBACK failed. It had no separate visible rollback diagnosis.                                                                                                                   |

This list covers all throwing operations inside the old pre-COMMIT try block.
Unknown/programming/driver exceptions at those locations also took the same catch
path. A COMMIT exception instead used the old uncertainty message. A client.end()
exception instead overwrote the result with the old connection-cleanup message.

Invalid arguments, noninteractive stdin/stdout, prompt setup/input exceptions,
or a thrown dotenv/startup exception used the old **startup** message instead.
Therefore the reported generic provisioning message is evidence that the old
argument/TTY gate passed. A PowerShell execution-policy failure would also have
produced a different message; npm.cmd avoids the npm.ps1 policy restriction.

dotenv is loaded after input. By default it reads `.env` from the working
directory and does not override existing process variables. A stale process value
can therefore override a correct file value. The old code ignored dotenv's
returned error; missing variables then failed later in connectionConfig. The new
code reports ENVIRONMENT_LOADING/ENVIRONMENT_READ when the file cannot be read.
A missing `.env` is allowed only when DATABASE_URL is already supplied through
the environment. Run from the repository root; do not print either source.

## New sanitized diagnostics

Failure diagnostics print only fixed stage/reason codes and transaction/cleanup status.
They never print raw error messages, stacks, error codes, SQL, database URLs,
passwords, project input, certificate contents, or database records.

Examples:

- INPUT_VALIDATION/PROJECT_REFERENCE_FORMAT
- INPUT_VALIDATION/CONFIRMATION_REQUIRED, CONFIRMATION_INCOMPLETE,
  CONFIRMATION_WHITESPACE, CONFIRMATION_CONTROL_CHARACTERS or CONFIRMATION_MISMATCH
- OPERATOR_INPUT/INPUT_CANCELLED_OR_CLOSED
- ENVIRONMENT_LOADING/ENVIRONMENT_READ
- CONFIGURATION/DATABASE_URL_FORMAT, DATABASE_URL_SHAPE, TLS_CONFIGURATION,
  V2_PROJECT_IDENTITY, CA_PATH_REQUIRED, CA_READ or CA_CERTIFICATE
- CLIENT_SETUP/DETAILS_WITHHELD
- DATABASE_CONNECTION/TLS_CERTIFICATE_UNTRUSTED, TLS_HOSTNAME,
  TLS_CERTIFICATE_EXPIRED, TLS_CERTIFICATE_NOT_YET_VALID, DATABASE_AUTHENTICATION,
  NETWORK_DNS, NETWORK_CONNECTION or NETWORK_TIMEOUT
- TRANSACTION_BEGIN/DATABASE_PERMISSION
- FACILITY_TYPES_INSERT/DATABASE_SCHEMA or INSERT_CARDINALITY
- EQUIPMENT_CATEGORIES_INSERT/SERIALIZATION_CONFLICT
- TRANSACTION_COMMIT/COMMIT_NOT_CONFIRMED

Known driver codes map to a fixed allowlist, including schema/conflict-constraint,
permission, read-only, constraints, serialization, deadlock, cancellation, lock
timeout, connection limits and shutdown. Unrecognized errors become DETAILS_WITHHELD;
they are never echoed or guessed from private message text. The stage still shows
which operation failed.

| Outcome/status           | Meaning and retry rule                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REFUSED_BEFORE_BEGIN     | BEGIN was never requested; no lookup inserts were requested. Correct the reported reason before a deliberate retry.                                        |
| BEGIN_UNCONFIRMED        | BEGIN was requested but its acknowledgement failed. No inserts or COMMIT were requested; rollback is attempted and reported.                               |
| FAILED_BEFORE_COMMIT     | An insert phase failed; COMMIT was not requested. Rollback is attempted and reported.                                                                      |
| Rollback=CONFIRMED       | The ROLLBACK command was acknowledged. This confirms rollback for a pre-COMMIT failure; it cannot establish what happened to an earlier uncertain COMMIT.  |
| Rollback=FAILED          | Rollback threw or its command acknowledgement was invalid; a separate TRANSACTION_ROLLBACK code is included. Stop and reconcile privately before retrying. |
| COMMIT_UNCERTAIN         | COMMIT was requested but not confirmed. A later successful ROLLBACK cannot prove whether that COMMIT succeeded. Inspect state privately first.             |
| COMMITTED_CLEANUP_FAILED | COMMIT was confirmed, but closing the connection failed. Do not treat this as a failed provisioning transaction.                                           |
| Cleanup=FAILED           | A separate CONNECTION_CLEANUP code is included without erasing the original failure or COMMIT uncertainty.                                                 |

The insert-only SQL, exact reviewed list, existing uniqueness constraints,
Serializable transaction, identity checks and verified TLS remain in force.
There are no automatic retries or schema repairs. COMMIT/ROLLBACK command tags
are checked before reporting acknowledgement; unexpected tags are failures.

## Input behavior verified offline

Tests use actual Node readline streams with Windows CRLF input, alongside mock
command/client/transaction fixtures. A complete phrase succeeds; CRLF is the line
terminator and is not part of the returned answer. Visual wrapping adds no input
character and does not truncate the phrase. A real newline/Enter mid-phrase
submits only the first part, which is rejected. Trailing spaces are retained and
rejected with CONFIRMATION_WHITESPACE. Truncation is rejected with
CONFIRMATION_INCOMPLETE when the supplied input is a prefix of the expected phrase.
Other edits use CONFIRMATION_MISMATCH. Closing stdin or cancelling a prompt now
aborts safely instead of leaving a pending question without a useful diagnosis.

These tests do not replay the operator's historical terminal session or prove
there was no terminal-specific issue. Enter each answer only when its prompt is
ready; do not paste both answers or multiple input lines at once.

## Safe operator retry

1. Keep the existing approval of the exact list. This diagnosis does not run
   another live attempt. Use a trusted, non-recorded terminal in the project root.
2. Set the existing trusted CA path and keep TLS verification enabled before
   launching Node. Do not edit DATABASE_URL just to bypass a reason code:

    ```powershell
    $env:NODE_EXTRA_CA_CERTS = "$HOME\Documents\IM101-Backups\supabase-v2-ca.crt"
    $env:NODE_TLS_REJECT_UNAUTHORIZED = "1"
    npm.cmd run provision:lookups -- --check-config
    ```

3. Enter the intended V2 reference independently from the dashboard. This mode
   validates local configuration and CA parsing only: it never creates a database
   client, connects, starts a transaction or writes. A PASS cannot validate remote
   credentials, reachability, the TLS handshake or actual database state. Share
   only the sanitized code if it fails; keep all configuration values private.
4. Resolve the reported reason. CA_PATH_REQUIRED means configure the variable;
   CA_READ means check its path/access; CA_CERTIFICATE means use the trusted CA
   file. For URL/identity issues, privately compare against the already verified
   V2 configuration. Keep verify-full, hostname verification and the strict
   project check. Never add sslmode=require or disable certificate checks.
5. For a prior FAILED_BEFORE_COMMIT with confirmed rollback, correct the cause
   before retrying. For failed rollback, uncertain COMMIT or cleanup failure,
   arrange an explicitly approved private state verification first. Do not assume
   a failed command means nothing happened, delete lookup rows, change tables,
   or retry automatically. The two old messages say COMMIT was not requested but
   do not confirm rollback; review that uncertainty with the operator before a
   live retry. No live state verification is part of this investigation.
6. Only when the operator deliberately chooses to retry the approved provisioning:

    ```powershell
    npm.cmd run provision:lookups -- --apply
    ```

    Enter the reference, wait for the confirmation prompt, then type the full
    `APPROVE SUGGESTED LOOKUPS IN <actual-project-reference>` on one input line,
    without angle brackets, extra spaces or a manual line break. Press Enter once.
    The script still requires this explicit per-run confirmation. It skips exact
    existing names, never changes/deletes existing lookups, and prints inserted/
    skipped totals only after COMMIT confirmation. On failure, stop and use the
    sanitized code/outcome rather than repeating the attempt blindly.

No live CRUD test is part of this retry or this diagnosis.
