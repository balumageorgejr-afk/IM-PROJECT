# Reservation creation input validation (Task 3)

`src/reservation-validation.js` exports the pure CommonJS function
`validateReservationCreation(payload)`. It is not mounted as an HTTP endpoint.
It imports no database, authentication, filesystem or networking module and does
not read environment variables, the local timezone or the current time.

## Result contract

Success returns `{ success: true, data: { facilityId, purpose, startDatetime,
endDatetime } }`. The returned object is new; timestamps are canonical UTC ISO
strings with exactly three fractional digits, suitable for future Prisma DateTime
input. Failure returns `{ success: false, errors: [{ field, code }, ...] }`, with
no partial data. Fields and codes are fixed identifiers, never supplied values,
unknown property names, stack traces or exception messages. The validator logs
nothing and does not throw request-derived exceptions to callers.

## Payload and facility ID

The payload must be a plain object (a null prototype is also accepted) with exactly
the four required, own, enumerable data properties. Arrays, class instances,
custom prototypes, accessors, symbol/hidden properties and unknown keys are
rejected. Missing or undefined required properties produce REQUIRED errors.
Unknown keys produce only a body/UNEXPECTED_FIELDS error, without echoing their
names. Client reservation/requester/approver/status IDs, createdAt and nested
equipment data are never accepted. No field is populated from defaults.

facilityId must satisfy Number.isInteger and be within 1 through 2,147,483,647.
Strings, booleans, BigInts, null, objects, arrays, nonfinite numbers and nonintegral
numbers are rejected without coercion. JSON parsing has already occurred: JavaScript
does not distinguish the numeric spellings 1 and 1.0 once parsed. Facility existence
is a future database check; a structurally valid ID does not prove existence.

## Purpose and Unicode

Purpose must be a well-formed Unicode string. Surrounding JavaScript whitespace
is trimmed; the result must contain 1 through 255 Unicode code points. Supplementary
characters such as a single emoji count as one; combining marks and ZWJ components
count separately. For example, decomposed e + combining acute counts as two.
This is not a UTF-8 byte, UTF-16 code-unit or grapheme-cluster limit. No Unicode
normalization or truncation occurs. Unpaired surrogates and remaining C0/C1 control
characters (including NUL) are rejected, following the project's text validation
conventions. Surrounding tabs/newlines can be trimmed; internal controls are refused.

## Timestamp profile and normalization

The accepted ISO 8601 extended profile is:
`YYYY-MM-DDTHH:mm:ss[.S|.SS|.SSS](Z|+HH:MM|-HH:MM)`.

- Uppercase T and Z, seconds and an explicit offset are mandatory. No surrounding
  whitespace, timezone-free, basic/week/ordinal dates, compact offsets, named zones
  or Date objects are accepted.
- Years are 0001 through 9999. The resulting UTC instant must remain within those
  years too. Year zero, expanded years and offset conversions outside that range
  are refused as representation limits, not booking-horizon policy.
- Gregorian calendar days are checked explicitly, including leap-year century
  rules. Hours are 00-23, minutes/seconds 00-59. Leap seconds and 24:00 are not
  supported; they are rejected rather than rolled into another instant.
- Numeric offset hours are 00-23 and minutes 00-59, matching the offset syntax in
  [RFC 3339 section 5.6](https://www.rfc-editor.org/rfc/rfc3339#section-5.6).
  This validates an explicit offset, not whether a geographic timezone currently
  uses it. Z and +00:00 are accepted; -00:00 is refused because that convention
  represents an unknown local offset ([section 4.3](https://www.rfc-editor.org/rfc/rfc3339#section-4.3)).
- Fractional seconds may have one, two or three digits. More digits, including
  additional zeros, produce TIMESTAMP_PRECISION. The approved database supports
  microseconds, but this module deliberately accepts only millisecond precision
  to avoid loss through JavaScript Date. No excess fraction is rounded/truncated.
- Conversion subtracts the declared numeric offset, using UTC operations only.
  Validated calendar components are used instead of permissive Date.parse input
  parsing. Fractions are padded to milliseconds without changing the instant.

The normalized start instant must be strictly before the normalized end instant.
Timezone-equivalent endpoints represent an identical instant and are therefore
rejected when used as start and end of the same reservation. Equivalent spellings
of either endpoint normalize identically across otherwise valid requests. Adjacent
requests can share an endpoint; no buffer or overlap check is performed here.

## Error codes and deferred checks

| Code                | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| INVALID_PAYLOAD     | Payload shape cannot safely be treated as a JSON-style object  |
| UNEXPECTED_FIELDS   | One or more keys are outside the fixed creation allowlist      |
| REQUIRED            | A known required field is absent/undefined                     |
| INVALID_FACILITY_ID | Invalid facilityId type or integer range                       |
| INVALID_PURPOSE     | Wrong type, empty trimmed text, malformed Unicode or controls  |
| PURPOSE_TOO_LONG    | More than 255 code points after trimming                       |
| INVALID_TIMESTAMP   | Invalid type, syntax, calendar/time/offset or unsupported form |
| TIMESTAMP_PRECISION | More than three fractional digits                              |
| TIMESTAMP_RANGE     | Year zero or an instant outside the supported UTC year range   |
| INVALID_TIME_ORDER  | Start is not strictly earlier than end                         |

Errors are reported in a deterministic order. Body-shape errors stop inspection;
otherwise known field errors can be returned together. Consumers must check success
before using data. Do not log the original payload alongside validation results.

Past intervals, durations beyond 8 hours and bookings beyond 90 days can pass this
structural validator. Future-only restrictions, duration, horizon, lead time,
buffers, overlaps, facility eligibility/existence, identity, RBAC, status resolution,
auditing and transaction/concurrency checks remain separate, approval-dependent
work. Successful validation does not authorize or create a reservation. Task 1 and
Task 2 GET behavior is unchanged; no POST route, procedures, triggers or provisioning
are introduced by Task 3.
