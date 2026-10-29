# Reservation usability

The frontend displays facility and equipment names in tables, reservation cards,
record details, loan items/return confirmations and form choices. Select values and
request bodies still use the original numeric IDs internally. No schema, backend
route, authorization rule or API response projection changed.

Existing authenticated catalog endpoints supply names. Selectors initially load up
to 100 choices and offer Load more when another page exists. Names referenced by a
displayed record but absent from those choices resolve through the existing facility
or equipment detail GET endpoint, with at most four concurrent requests. Failed or
inaccessible lookups show Facility unavailable or Equipment unavailable without an
ID or private diagnostic. Selecting a different maintenance target type clears the
previous target selection; its request payload remains exactly one target ID.

Shared formatting renders dates as MM/DD/YYYY and datetimes as
MM/DD/YYYY hh:mm AM/PM in the browser's local timezone. Date-only assignment values
retain their stored calendar day rather than shifting to another local day. Native
date/time form controls retain their browser-specific picker and submit the existing
normalized UTC timestamps; no booking-time policy changed.

List and dashboard purpose previews use the first nonempty line, or its first short
sentence/semicolon segment, and cap long previews at 64 Unicode code points plus an
ellipsis. View Details retains the complete original purpose with line breaks as
plain text. Previewing never changes a stored purpose or a submitted payload.

Reservations has List view and Approved calendar controls, with Calendar also in the
role-aware sidebar. Phones show a daily agenda for the selected month. The read-only month view
shows only records whose status ID matches the actual Approved lookup value. There
are no hardcoded status IDs, calendar mutations, drag/drop or new permissions.
Clicking an event loads its existing authorized detail endpoint. Multi-day bookings
appear on every intersecting local calendar day; adjacent events are not treated as
overlapping by this display. Missing Approved configuration fails closed with a notice.

The calendar uses only the unchanged ownership-scoped reservation list API. Staff and
representatives still see only their own records; administrators retain their existing
visibility. This is not a campus-wide availability calendar and does not prove that an
empty slot can be booked. Backend checks remain authoritative on every mutation.

History loads in batches of at most ten GET requests of 100 records each. If more
history exists, the view explicitly warns that it is incomplete and offers Load more
reservations. Month navigation uses the loaded history; Refresh calendar reads it
again. Large histories may eventually warrant an independently reviewed server-side
calendar-range filter, but no API changes were needed for this pass.

Offline coverage checks numeric dates/timezone equivalence, previews/full details,
name-only labels and internal ID payloads, missing and later-page names, maintenance
target switching, Approved-only calendar events, pagination, and list/calendar/detail
navigation. These tests do not claim a new visual browser acceptance pass.
