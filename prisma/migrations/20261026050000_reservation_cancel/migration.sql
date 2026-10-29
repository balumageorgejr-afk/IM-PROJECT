-- PROVISIONAL offline policy; not deployed.
BEGIN;
CREATE PROCEDURE im101_private.cancel_reservation(IN p_id integer, INOUT p_result_id integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET timezone = 'UTC'
AS $cancel$
DECLARE actor_text text; actor integer; actor_role text; facility integer; facility_status text;
  pending integer; approved integer; cancelled integer; lookup_count integer; checked_at timestamptz; booking public.reservations%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION USING ERRCODE = 'R4091', MESSAGE = 'Reservation transaction conflict.';
  END IF;
  actor_text := pg_catalog.current_setting('im101.actor_id', true);
  IF actor_text IS NULL OR length(actor_text) NOT BETWEEN 1 AND 10 OR actor_text !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION USING ERRCODE = 'R4011', MESSAGE = 'Reservation actor context required.';
  END IF;
  IF actor_text::bigint > 2147483647 THEN
    RAISE EXCEPTION USING ERRCODE = 'R4011', MESSAGE = 'Reservation actor context required.';
  END IF;
  actor := actor_text::integer;
  SELECT r.role_name INTO actor_role FROM public.users u JOIN public.roles r ON r.role_id=u.role_id
    WHERE u.user_id=actor AND u.is_active FOR SHARE OF u,r;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'R4011', MESSAGE = 'Reservation actor context required.';
  END IF;
  IF actor_role NOT IN ('System Administrator','Facility/Maintenance Staff','Faculty / Student Organization Representative') THEN
    RAISE EXCEPTION USING ERRCODE = 'R4031', MESSAGE = 'Reservation access denied.';
  END IF;
  IF p_id IS NULL OR p_id<1 OR p_result_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='R4001', MESSAGE='Invalid reservation input.';
  END IF;
  -- Fixed lock order: actor/role, lookup rows, facility, then reservation rows.
  PERFORM status_id FROM public.reservation_status
    WHERE status_name IN ('Pending','Approved','Rejected','Cancelled') ORDER BY status_id FOR SHARE;
  GET DIAGNOSTICS lookup_count = ROW_COUNT;
  IF lookup_count <> 4 THEN
    RAISE EXCEPTION USING ERRCODE = 'R5031', MESSAGE = 'Reservation configuration unavailable.';
  END IF;
  SELECT status_id INTO pending FROM public.reservation_status WHERE status_name='Pending';
  SELECT status_id INTO approved FROM public.reservation_status WHERE status_name='Approved';
  SELECT status_id INTO cancelled FROM public.reservation_status WHERE status_name='Cancelled';
  SELECT facility_id INTO facility FROM public.reservations WHERE reservation_id=p_id AND (requested_by=actor OR actor_role='System Administrator');
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='R4041', MESSAGE='Reservation resource not found.';
  END IF;
  SELECT status INTO facility_status FROM public.facilities WHERE facility_id=facility FOR UPDATE;
  SELECT * INTO booking FROM public.reservations WHERE reservation_id=p_id AND (requested_by=actor OR actor_role='System Administrator') FOR UPDATE;
  IF NOT FOUND OR booking.facility_id<>facility THEN
    RAISE EXCEPTION USING ERRCODE='R4091', MESSAGE='Reservation transaction conflict.';
  END IF;
  IF booking.status_id NOT IN (pending,approved) OR booking.start_datetime <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='R4091', MESSAGE='Reservation transition conflict.';
  END IF;
  UPDATE public.reservations SET status_id=cancelled WHERE reservation_id=p_id
    RETURNING reservation_id INTO p_result_id;
END
$cancel$;
REVOKE ALL ON PROCEDURE im101_private.cancel_reservation(integer,integer) FROM PUBLIC;
GRANT CREATE ON SCHEMA im101_private TO im101_reservation_owner;
ALTER PROCEDURE im101_private.cancel_reservation(integer,integer) OWNER TO im101_reservation_owner;
REVOKE CREATE ON SCHEMA im101_private FROM im101_reservation_owner;
GRANT EXECUTE ON PROCEDURE im101_private.cancel_reservation(integer,integer) TO im101_reservation_runtime;
COMMIT;
