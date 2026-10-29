-- PROVISIONAL offline policy; deployment requires separate review and authorization.
BEGIN;
GRANT USAGE ON SCHEMA im101_private TO im101_reservation_runtime;
GRANT SELECT ON public.reservations, public.facilities, public.reservation_status
  TO im101_reservation_owner;
GRANT SELECT (user_id, role_id, is_active) ON public.users TO im101_reservation_owner;
GRANT SELECT (role_id, role_name) ON public.roles TO im101_reservation_owner;
-- Row-lock privileges, not application runtime write grants.
GRANT UPDATE (user_id) ON public.users TO im101_reservation_owner;
GRANT UPDATE (role_id) ON public.roles TO im101_reservation_owner;
GRANT UPDATE (status_id) ON public.reservation_status TO im101_reservation_owner;
GRANT UPDATE (facility_id) ON public.facilities TO im101_reservation_owner;
GRANT INSERT ON public.reservations TO im101_reservation_owner;
GRANT USAGE ON SEQUENCE public.reservations_reservation_id_seq TO im101_reservation_owner;

CREATE PROCEDURE im101_private.create_reservation(
  IN p_facility_id integer, IN p_purpose text, IN p_start timestamptz, IN p_end timestamptz,
  INOUT p_reservation_id integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET timezone = 'UTC'
AS $create$
DECLARE actor_text text; actor integer; actor_role text; facility_status text;
  pending integer; approved integer; lookup_count integer; checked_at timestamptz;
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
  IF p_reservation_id IS NOT NULL OR p_facility_id IS NULL OR p_facility_id < 1 OR p_purpose IS NULL
    OR p_purpose <> btrim(p_purpose) OR char_length(p_purpose) NOT BETWEEN 1 AND 255
    OR p_purpose ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING ERRCODE = 'R4001', MESSAGE = 'Invalid reservation input.';
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
  SELECT status INTO facility_status FROM public.facilities WHERE facility_id=p_facility_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'R4041', MESSAGE = 'Reservation resource not found.';
  END IF;
  IF facility_status <> 'Available' THEN
    RAISE EXCEPTION USING ERRCODE = 'R4091', MESSAGE = 'Reservation facility unavailable.';
  END IF;
  checked_at := pg_catalog.clock_timestamp();
  IF p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end)
    OR date_trunc('milliseconds',p_start) <> p_start OR date_trunc('milliseconds',p_end) <> p_end
    OR p_start <= checked_at OR p_end <= p_start OR p_end-p_start > interval '8 hours'
    OR p_start > checked_at+interval '90 days' OR p_end > checked_at+interval '90 days' THEN
    RAISE EXCEPTION USING ERRCODE = 'R4001', MESSAGE = 'Invalid reservation time interval.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservations WHERE facility_id=p_facility_id AND status_id=approved
    AND start_datetime<p_end AND end_datetime>p_start) THEN
    RAISE EXCEPTION USING ERRCODE = 'R4091', MESSAGE = 'Reservation schedule conflict.';
  END IF;
  INSERT INTO public.reservations(facility_id,requested_by,approved_by,status_id,purpose,start_datetime,end_datetime)
    VALUES(p_facility_id,actor,NULL,pending,p_purpose,p_start,p_end) RETURNING reservation_id INTO p_reservation_id;
END
$create$;
REVOKE ALL ON PROCEDURE im101_private.create_reservation(integer,text,timestamptz,timestamptz,integer) FROM PUBLIC;
GRANT CREATE ON SCHEMA im101_private TO im101_reservation_owner;
ALTER PROCEDURE im101_private.create_reservation(integer,text,timestamptz,timestamptz,integer) OWNER TO im101_reservation_owner;
REVOKE CREATE ON SCHEMA im101_private FROM im101_reservation_owner;
GRANT EXECUTE ON PROCEDURE im101_private.create_reservation(integer,text,timestamptz,timestamptz,integer) TO im101_reservation_runtime;
COMMIT;
