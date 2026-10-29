# Phase 7 Task 4: operator runbook

Preparation only. No live database connection or write is authorized by this document.
Obtain separate explicit operator/instructor approval for the lookup list and later
for the disposable CRUD exercise. Running quality checks never launches either live
procedure. Do not run migrations, schema push, seed commands, or the initial-admin
provisioner for this task.

## Verified repository definitions

The approved DBML, `prisma/schema.prisma` and
`prisma/migrations/20261019020000_supabase_v2_init/migration.sql` agree:

| Prisma model/field             | Physical table/column              | Definition                              |
| ------------------------------ | ---------------------------------- | --------------------------------------- |
| FacilityType.facilityTypeId    | facility_types.facility_type_id    | SERIAL / integer primary key, generated |
| FacilityType.typeName          | facility_types.type_name           | VARCHAR(50), NOT NULL, unique           |
| EquipmentCategory.categoryId   | equipment_categories.category_id   | SERIAL / integer primary key, generated |
| EquipmentCategory.categoryName | equipment_categories.category_name | VARCHAR(50), NOT NULL, unique           |

Unique indexes are `facility_types_type_name_key` and
`equipment_categories_category_name_key`. Names use PostgreSQL's ordinary unique
comparison; the scripts do not assume case-insensitive uniqueness or normalize old
records. Facilities require `facility_type_id` referencing FacilityType;
Equipment requires `category_id` referencing EquipmentCategory. Both FKs have
`ON DELETE NO ACTION ON UPDATE NO ACTION`. The lookups have no description,
status, timestamp, or soft-delete column. Neither lookup contains approved value
enumerations in the schema. This is repository verification, not a new inspection
of live database metadata. The previous read-only live verification is supplied
context; this preparation does not reconfirm it.

## Suggested values: approval required

These are suggestions for a university campus, **not existing approved values**.
The fixed list in `scripts/provision-lookups.js` is the full proposed list:

- Facility Types: Classroom, Lecture Hall, Laboratory, Computer Laboratory,
  Conference Room, Auditorium, Gymnasium, Study Room.
- Equipment Categories: Audio Visual Equipment, Computer Equipment, Laboratory
  Equipment, Sports Equipment, Furniture, Maintenance Tools.

The categories group common teaching, events, sports and maintenance resources.
Review terminology with the instructor, including whether Laboratory and Computer
Laboratory should be separate. Review this exact script/list before approval.
There is no input file, arbitrary SQL option, API route, or runtime list override.
If different values are approved, revise the source and tests, repeat offline
checks, and obtain approval of the revised list before applying it. The CRUD
exercise expects the exact names Classroom and Computer Equipment; revise and
review that selection too if those names are not approved.

## Offline preparation and tests

From the project root:

On Windows, use `npm.cmd` in place of `npm` if PowerShell blocks `npm.ps1`.
This uses the installed npm executable without changing execution policy.

```powershell
npm run provision:lookups
npm run quality
npm run audit
```

The first command only prints suggestions; it does not load `.env`, create a
database client, or connect. Quality includes schema validation, formatting checks,
syntax checks, linting, client generation and all mock tests. The audit contacts
the npm registry, never Supabase. No new dependency is required.

New mocks check fixed names/limits, repeat provisioning, preservation of existing
values, insert-only SQL, missing approval, wrong project, insecure TLS, invalid CA,
rollback, uncertain commit and cleanup failure. CRUD mocks check administrator
login/profile, absent lookups, receipt failure, linked IDs from POST responses,
disposable labels, exact snapshots before mutation, unexpected responses,
stop-on-failure, child-first deletion and post-delete 404s. No test connects to a
database. Existing route tests cover validation, authorization and dependency
conflicts; they remain offline.

## Lookup operator steps: only after separate approval

If provisioning fails, follow the [local diagnosis and safe retry guide](lookup-provisioning-diagnosis.md).
`npm.cmd run provision:lookups -- --check-config` checks local configuration and CA
parsing without creating a database client or connecting. Failures now include
sanitized stage/reason codes plus separate rollback and cleanup status.

1. Have the instructor/operator approve the exact suggested list above. Record
   approval privately with the intended V2 project reference. This preparation
   task is not that approval.
2. Use a trusted, non-recorded PowerShell 7.3+ terminal in this repository. Stop
   terminal transcripts. Confirm `.env` privately contains the already verified
   V2 `DATABASE_URL`. Do not display it, place it on a command line, or paste it
   into chat. Keep `sslmode=verify-full`. Do not change credentials.
3. Use the existing trusted V2 CA file and enable verification before starting Node:

    ```powershell
    $env:NODE_EXTRA_CA_CERTS = "$HOME\Documents\IM101-Backups\supabase-v2-ca.crt"
    $env:NODE_TLS_REJECT_UNAUTHORIZED = "1"
    npm run provision:lookups
    npm run provision:lookups -- --apply
    ```

4. Read the printed list again. At the interactive prompts enter the V2 project
   reference copied independently from the dashboard and, only if approved, type
   `APPROVE SUGGESTED LOOKUPS IN <project-reference>` with the actual reference.
   Any other response cancels before client creation. Piped/redirected apply is
   refused. The database credentials identify the trusted database operator;
   this is a local CLI with no web endpoint, not a public seeding feature.
5. Read the inserted/skipped summary. Retain it privately. Repeating the approved
   procedure is idempotent: exact existing names are skipped with their IDs
   untouched. There are no UPDATE, DELETE, upsert-update, raw SQL input, or DDL
   operations. Two fixed parameterized INSERT statements use the existing unique
   indexes and `ON CONFLICT ... DO NOTHING`, inside one Serializable transaction.
   Concurrent conflicts fail safely without automatic retries; sequence gaps are
   normal even when inserts are skipped or rolled back.
6. On failure, stop and review privately. A lost COMMIT response or connection
   cleanup failure may mean inserts completed; do not infer rollback. A trusted
   operator can inspect only `facility_type_id,type_name` and
   `category_id,category_name` through the approved read-only database tool. Check
   exact names, one row each, and existing IDs before approving any rerun. No
   lookup rollback/delete procedure is provided.

TLS and identity checks reuse `connectionConfig` from the existing password
recovery script, without invoking password recovery. It requires the intended
direct host or session pooler identity, port 5432, database postgres, the sole URL
query parameter `sslmode=verify-full`, an actual trusted CA, certificate chain and
hostname verification. Explicit pg configuration prevents URL options overriding
TLS. The procedure does not change roles, users, credentials or table definitions.

## Live CRUD operator steps: independent approval required

1. After lookup provisioning is approved and complete, separately obtain explicit
   approval to create, update **and delete** exactly three disposable management
   records. Agree on an exclusive test window: other operators must not edit,
   reserve, loan, maintain, or otherwise use these test records during the run.
   The APIs do not offer conditional version checks, so a GET before mutation
   cannot prevent concurrent edits. If an exclusive window cannot be ensured,
   do not run this exercise. Existing real records need not be empty and must
   never be used as test targets.
2. Review `scripts/verify-live-crud.js` and `.ps1`. Ensure the private `tmp`
   directory is writable and access is limited to the operator. On Windows the
   filesystem ACL is authoritative; Unix mode bits alone do not secure it.
   Receipts are ignored by Git, contain test records/project reference only, and
   must not contain passwords, JWTs, database URLs or real campus records.
3. In the same trusted PowerShell 7.3+ terminal, run **manually**:

    ```powershell
    npm run verify:live-crud
    ```

4. Enter the intended V2 project reference from the dashboard. Only after the
   independent CRUD approval, type
   `CREATE UPDATE DELETE DISPOSABLE RECORDS IN <project-reference>` using the
   actual reference. The credential dialog then takes the **existing**
   administrator email and password privately. Do not put credentials in command
   history, environment variables, screenshots or receipts. The launcher pipes
   them to Node in memory and suppresses native diagnostics. It restores its
   temporary environment changes on exit.
5. The runner validates V2 identity and verified TLS, starts a temporary local API
   on an ephemeral `127.0.0.1` port, and uses the existing `/api/auth/login` and
   `/api/auth/me` flow. It checks the System Administrator role/profile, uses a
   temporary in-memory JWT signing secret, and selects the IDs of Classroom and
   Computer Equipment by exact unique name. Missing prerequisites stop the run
   before any management writes. It does not create accounts or lookups.
6. It prints a private receipt path `tmp/live-crud/<random-run-id>.jsonl`. Keep
   that file. It records intent synchronously before each mutation, created
   snapshots and returned IDs, updates, deletes and completion. There is no
   restart/recovery mode accepting external IDs or labels.
   Snapshots are newly constructed from independently allowlisted fields only
   after exact shape, scalar-type and disposable-identity validation. Full API
   response objects, authentication results and raw lookup objects are never
   copied into receipts. See the receipt privacy and Windows permissions notes below.
7. The approved test sequence is:

    | Operation                                                   | Expected result                                                                                         |
    | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
    | POST /api/buildings                                         | 201; random `IM101-DISPOSABLE-<UUID>-B`, 2 floors                                                       |
    | POST /api/facilities                                        | 201; matching `-F`, returned building ID, approved type ID, floor 1, capacity 1                         |
    | POST /api/equipment                                         | 201; matching `-E`, returned facility ID, approved category ID, unique marked serial, total/available 1 |
    | GET each returned ID                                        | 200; exact created snapshot                                                                             |
    | PUT each returned ID                                        | 200; building location note marked UPDATED, facility capacity 2, equipment condition Fair               |
    | GET each updated ID                                         | 200; exact expected updated snapshot                                                                    |
    | GET then DELETE equipment, facility, building in that order | 200; exact snapshot before mutation and in deletion response                                            |
    | GET after each DELETE                                       | 404; record absent                                                                                      |

    Each PUT/DELETE target must be an ID received from this run's successful POST,
    with all original data matching. Names alone, prefix searches and guessed IDs
    never authorize changes. Real records and lookup rows are never cleanup
    targets. Existing NO ACTION foreign keys remain active; a 409 stops the run.

8. Only PASS plus a complete receipt indicates the full exercise passed. Review
   the receipt for all three created/deleted IDs. The local server and database
   pool close, and credentials/token references are cleared. JavaScript cannot
   guarantee erasure of previous memory copies. The launcher never prints them.

## Failure or interrupted run

Stop at the first unexpected status, body, changed snapshot or receipt failure.
There is no automatic retry and no cleanup in catch/finally. Earlier writes may
have succeeded. Do not rerun hoping to clean old records; a new run has a new UUID.

If a response is rejected after POST, the database may already contain the test
record even though no created snapshot or returned ID was saved. Only the earlier
fixed intent is retained. Do not salvage fields from that rejected response as
trusted creation evidence. If a DELETE response is rejected or lost, deletion may
already have committed; the runner does not continue deleting parent records.
Use earlier validated snapshots and independent evidence to reconcile state.
Receipt write/flush failures may leave an incomplete final JSONL entry. Retain the
file and use its complete validated entries; never overwrite it during a retry.

If a POST response was lost, its intent identifies a candidate only. An intent or
matching label is **not** proof of creation. Have a trusted operator reconcile the
private receipt with database/API state and trusted request/database logs. Obtain
separate approval for manual cleanup of leftovers. Positive proof must include
the successful create result/independent creation evidence, exact ID, unique run
marker, full expected field values and relationships, and absence of real usage
or dependencies. A failed receipt write after a successful POST may require this
independent evidence too. When proof is incomplete, leave the record untouched.

For positively identified leftovers only, privately authenticate with the existing
administrator flow, GET the exact proven IDs, compare their full state with the
last confirmed receipt (reconcile uncertain PUT outcomes first), then DELETE only
those IDs in equipment → facility → building order. Expect 200, followed by GET 404. Stop on any mismatch or 409; never remove dependencies to force cleanup,
broaden a delete, use deleteMany/TRUNCATE, or alter real data. Do not delete lookup
records. Preserve evidence of unresolved leftovers for the instructor/operator.

## Receipt privacy protections

The runner maintains its own field lists, independent of the business routes'
select objects. These are the approved Prisma scalar response fields; relation
objects and all additional fields are rejected:

| Model     | Exact required response fields                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Building  | buildingId, buildingName, floorCount, locationNote                                                                                 |
| Facility  | facilityId, buildingId, facilityTypeId, facilityName, floorNumber, capacity, status, createdAt                                     |
| Equipment | equipmentId, categoryId, homeFacilityId, equipmentName, serialNumber, totalQuantity, availableQuantity, conditionStatus, createdAt |

Every POST, GET, PUT and DELETE management response is checked, including its
response envelope. Missing, additional, nested, accessor or inherited fields,
wrong types and malformed objects stop the run. No blacklist of secret names is
used: every unexpected field is refused, whatever its name or value. IDs must be
positive PostgreSQL integers; floor values must fit SmallInt, quantities must be
nonnegative integers and available quantity cannot exceed total. Text follows the
approved length limits and rejects malformed Unicode/control characters. Nullable
columns accept null at the type-check level, but must still equal this run's
fixed expected value. createdAt must be a real canonical UTC ISO timestamp in the
format emitted by the API, then remain unchanged throughout that record's checks.

The generated marker, submitted metadata and exact parent/lookup IDs must match.
After POST, the generated record ID and timestamp are pinned in the validated
snapshot. Every pre-mutation GET must match that snapshot in full. Snapshots are
fresh frozen objects holding only checked primitive values; the original response
is never serialized or retained as a snapshot. Update receipts contain the newly
validated expected state. Delete receipts contain only the known collection and
previously validated ID. Start entries explicitly select the two validated lookup
IDs; they do not spread returned lookup data. Intent payloads come from the fixed
disposable plan, not remote response data. Login/profile objects, passwords, JWTs
and connection settings have no receipt-entry path.

Only fixed diagnostic codes and fixed guidance are displayed. Field names,
unexpected values, raw errors, response bodies, SQL and connection strings are
withheld. Response validation errors also avoid assertion actual/expected dumps.
Examples:

- RESPONSE_UNEXPECTED_FIELDS: an extra field was present; none of that response
  was written as a snapshot. Earlier validated entries remain available.
- RESPONSE_MISSING_FIELDS, RESPONSE_SHAPE, RESPONSE_FIELD_TYPE: incomplete,
  malformed or incorrectly typed data; stop without guessing missing values.
- RESPONSE_IDENTITY: data differs from the expected disposable record.
- RESPONSE_ENVELOPE, RESPONSE_STATUS: unexpected success flag, response structure,
  missing-record message or HTTP status.
- HTTP_RESPONSE_UNCERTAIN: transport/response parsing failed; a preceding write
  may already have committed. Never retry automatically.
- RECEIPT_WRITE_FAILED: receipt persistence/flush failed; prior complete entries
  remain the recovery starting point, and earlier API writes may have succeeded.
- RESOURCE_CLEANUP_FAILED: closing a resource failed. If another error occurred
  first, its original diagnostic is preserved alongside this cleanup code.

Validation failures never truncate or delete existing receipts and never trigger
record cleanup. There is still no atomic version guard between GET and mutation;
the exclusive test window and separate authorization remain required.

## Windows receipt permissions

Node's `mkdir(..., mode: 0o700)` and `open(..., "wx", 0o600)` do not establish a
private Windows DACL. Windows uses inherited and explicit ACL entries; Node mode
bits are not an operator-only access guarantee. Existing directories are not
secured retroactively by mkdir. Exclusive `wx` creation prevents overwriting an
existing receipt, and `.gitignore` prevents normal Git inclusion; neither limits
who can read a receipt on disk. Flushing entries does not encrypt them.

The offline check for this hardening found `tmp` with inheritance enabled and six
inherited allow entries. No allow entries for Everyone, Authenticated Users or
the built-in Users group were found in that limited check. `tmp/live-crud` did not
exist, so no actual receipt-file DACL could be certified. Other principals, group
membership, deny rules and elevated access still require an operator review.

Before separately authorizing a live run, the operator should inspect the existing
parent and the intended receipt directory privately:

```powershell
Get-Acl -LiteralPath .\tmp | Format-List
# Once the operator has prepared the private directory:
Get-Acl -LiteralPath .\tmp\live-crud | Format-List
```

Use Windows Security / Advanced Security or the institution's approved ACL tooling
to prepare the directory so only the operator and required trusted administrative
principals have access. Review inherited permissions and the permissions new files
will inherit. Do not infer privacy just from the lack of the three common groups
above. This procedure does not change ACLs automatically. Administrators, SYSTEM,
backup tools and a compromised local machine remain outside an application-level
privacy guarantee. Use a trusted machine and non-recorded terminal. Credentials
also exist temporarily in process memory/stdin; JavaScript cannot guarantee secure
erasure of every memory copy. Do not share raw receipt or diagnostic-tool output.

This runbook and its tests prepare the procedure only. Live execution remains a
separate operator action after explicit approval.
