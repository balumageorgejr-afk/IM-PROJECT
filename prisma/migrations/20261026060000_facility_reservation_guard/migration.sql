-- PROVISIONAL: active or future Approved bookings prevent unavailability.
-- Additive protection for the existing Facilities UPDATE API; no table changes.
BEGIN;
CREATE FUNCTION im101_private.guard_facility_reservations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE approved integer; lookup_count integer;
BEGIN
  IF TG_RELID <> 'public.facilities'::regclass OR TG_OP <> 'UPDATE' OR TG_LEVEL <> 'ROW' OR TG_WHEN <> 'BEFORE' THEN
    RAISE EXCEPTION USING ERRCODE='R4031', MESSAGE='Facility operation refused.';
  END IF;
  IF NEW.status='Available' THEN RETURN NEW; END IF;
  IF pg_catalog.current_setting('transaction_isolation')<>'serializable' THEN
    RAISE EXCEPTION USING ERRCODE='R4091', MESSAGE='Facility transaction conflict.';
  END IF;
  -- UPDATE already holds the facility row lock; approval locks this same row.
  PERFORM status_id FROM public.reservation_status
    WHERE status_name IN ('Pending','Approved','Rejected','Cancelled') ORDER BY status_id FOR SHARE;
  GET DIAGNOSTICS lookup_count = ROW_COUNT;
  IF lookup_count<>4 THEN
    RAISE EXCEPTION USING ERRCODE='R5031', MESSAGE='Reservation configuration unavailable.';
  END IF;
  SELECT status_id INTO approved FROM public.reservation_status WHERE status_name='Approved';
  IF EXISTS (SELECT 1 FROM public.reservations WHERE facility_id=OLD.facility_id AND status_id=approved
    AND end_datetime>pg_catalog.clock_timestamp()) THEN
    RAISE EXCEPTION USING ERRCODE='R4091', MESSAGE='Facility has active or future approved reservations.';
  END IF;
  RETURN NEW;
END
$guard$;
REVOKE ALL ON FUNCTION im101_private.guard_facility_reservations() FROM PUBLIC;
GRANT CREATE ON SCHEMA im101_private TO im101_reservation_owner;
ALTER FUNCTION im101_private.guard_facility_reservations() OWNER TO im101_reservation_owner;
REVOKE CREATE ON SCHEMA im101_private FROM im101_reservation_owner;
CREATE TRIGGER facility_reservation_guard BEFORE UPDATE OF status ON public.facilities
  FOR EACH ROW EXECUTE FUNCTION im101_private.guard_facility_reservations();
COMMIT;
