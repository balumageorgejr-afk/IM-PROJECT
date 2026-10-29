# Campus workspace redesign

This frontend-only change preserves existing Express APIs, database-backed RBAC,
approved schema and all migrations. It includes the preceding reservation usability
and modal-focus work as a separate preservation commit. The original work is also
recoverable from the pre-redesign stash.

## Main workflows

- Administrators see campus totals, actual pending reservation/loan counts and open
  maintenance, followed by pending work and quick review links.
- Maintenance staff see assigned work, work in progress, other borrowers' pending
  loans and their own reservations. Maintenance opens with Assigned to me enabled;
  disabling it shows other reports already authorized by the backend.
- Representatives see upcoming reservations, their active loans and open reports,
  with direct actions to browse spaces, borrow equipment or report an issue.
- Facilities and equipment offer cards as well as tables. Reserve/Borrow carries the
  selected resource into a request form; requester, approver and status never come
  from URL parameters. Navigation has distinct Calendar and read-only Profile pages.
- Search applies only to the current server-paginated page, and is explicitly labelled
  that way. Supported loan/maintenance/assignment filters still use existing APIs.
  No unsupported server search or sort parameters are introduced.

Shared components cover the shell, role navigation, page headings, statistics,
tables, resource cards, skeletons, empty states, notices and toast feedback. Existing
form/detail/confirmation dialogs retain focus trapping and stop-on-uncertainty guards.
Mobile navigation has an overlay, Escape handling and focus return. Tables become
labelled record stacks on narrow screens; the month calendar becomes a readable
daily agenda on phones instead of requiring seven tiny columns.

## Names, forms and dates

Resource selectors have a text search over loaded choices and a native select for
keyboard accessibility. Existing catalog pagination provides more choices. Facility
context and equipment quantity/condition help users choose without entering IDs.
Unavailable targets show a neutral message, never an invented name. People outside
the available staff catalog are described generically rather than fetched through an
unauthorized user directory. Profile shows only the existing authenticated profile.

Forms provide short descriptions, required indicators and field-linked validation.
Reservation start/end ordering, the existing provisional 8-hour/90-day rules, future
loan due dates, Unicode length, duplicate loan items and inventory bounds receive
immediate feedback. Backend validation remains authoritative, especially for races,
eligibility, permissions and the actual database clock. Controls are disabled during
submission; uncertain writes require reconciliation, not automatic retry.

Dates retain the shared MM/DD/YYYY and local MM/DD/YYYY hh:mm AM/PM presentation.
Native pickers send the existing ISO timestamps. Date-only assignment values retain
their UTC calendar day. Purpose previews never modify stored text; Details shows
the full original purpose. Friendly request references replace unexplained bare IDs.

## Scope and verification limits

Dashboards use real overview totals and bounded, ownership-scoped history reads.
Activity scans stop after 1,000 records per module. Partial activity counts display
a + and an explicit lower-bound notice; they are not represented as complete totals.
Catalogs initially load 100 choices, with further pages available explicitly.
Searchable selectors search loaded choices, not an undocumented global search API.

The approved-only calendar is still scoped by the existing backend: administrators
see authorized campus requests, while staff/representatives see their own. Empty
calendar slots are not proof of global availability. No private purposes are exposed
to other users, and no broader availability API is introduced.

Offline tests cover role-specific navigation, card-to-request selection, exact
payloads, profile access, staff work visibility, linked validation errors, selector
search, mobile focus handling, responsive table semantics and phone calendar events.
They complement existing authentication, dates, purpose, approval and uncertainty
tests; they do not substitute for visual browser acceptance.

Computer Use found Brave but refused permission to use it. No screenshots or completed
browser acceptance are claimed. Operator review on the existing local demo should
cover login, all three dashboards, resource cards, request forms, calendar, returns,
maintenance, assignments, profile, narrow widths, keyboard navigation and error states.
The private local demo files, credentials, data and lifecycle are excluded from Git.
There is no deployment, migration, provisioning or live Supabase operation in this PR.
