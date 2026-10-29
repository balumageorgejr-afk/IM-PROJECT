-- OFFLINE ARTIFACT: not deployed. Dedicated NOLOGIN roles are operator prerequisites.
-- No approved table definition, existing data, or unrelated ACL is changed.
BEGIN;
DO $check$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['im101_reservation_owner', 'im101_reservation_audit_writer', 'im101_reservation_runtime'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r AND NOT rolcanlogin
      AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls) THEN
      RAISE EXCEPTION USING ERRCODE = 'R5031', MESSAGE = 'Reservation deployment prerequisites not satisfied.';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles p ON p.oid=m.member WHERE p.rolname=r)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles p ON p.oid=c.relowner
        WHERE p.rolname=r AND c.relnamespace='public'::regnamespace) THEN
      RAISE EXCEPTION USING ERRCODE = 'R5031', MESSAGE = 'Reservation deployment prerequisites not satisfied.';
    END IF;
  END LOOP;
  IF pg_catalog.pg_has_role('im101_reservation_runtime', 'im101_reservation_owner', 'MEMBER')
    OR pg_catalog.pg_has_role('im101_reservation_runtime', 'im101_reservation_audit_writer', 'MEMBER')
    OR pg_catalog.has_table_privilege('im101_reservation_runtime', 'public.reservations', 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
    OR pg_catalog.has_table_privilege('im101_reservation_runtime', 'public.audit_logs', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') THEN
    RAISE EXCEPTION USING ERRCODE = 'R5031', MESSAGE = 'Reservation deployment prerequisites not satisfied.';
  END IF;
  IF pg_catalog.has_any_column_privilege('im101_reservation_runtime', 'public.reservations', 'INSERT,UPDATE')
    OR pg_catalog.has_any_column_privilege('im101_reservation_runtime', 'public.audit_logs', 'SELECT,INSERT,UPDATE')
    OR pg_catalog.has_schema_privilege('im101_reservation_runtime', 'public', 'CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member
      WHERE r.rolname='im101_reservation_runtime') THEN
    RAISE EXCEPTION USING ERRCODE = 'R5031', MESSAGE = 'Reservation deployment prerequisites not satisfied.';
  END IF;
END
$check$;
CREATE SCHEMA im101_private;
REVOKE ALL ON SCHEMA im101_private FROM PUBLIC;
GRANT USAGE ON SCHEMA public, im101_private TO im101_reservation_audit_writer, im101_reservation_owner;
GRANT INSERT (table_name, record_id, action_type, changed_by, old_value, new_value)
  ON public.audit_logs TO im101_reservation_audit_writer;
GRANT USAGE ON SEQUENCE public.audit_logs_log_id_seq TO im101_reservation_audit_writer;
GRANT SELECT (user_id, is_active) ON public.users TO im101_reservation_audit_writer;

CREATE FUNCTION im101_private.audit_reservation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $audit$
DECLARE actor_text text; actor integer; before_value jsonb; after_value jsonb;
BEGIN
  IF TG_RELID <> 'public.reservations'::regclass OR TG_LEVEL <> 'ROW' OR TG_WHEN <> 'AFTER'
    OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
    RAISE EXCEPTION USING ERRCODE = 'R4031', MESSAGE = 'Reservation audit refused.';
  END IF;
  actor_text := pg_catalog.current_setting('im101.actor_id', true);
  IF actor_text IS NULL OR length(actor_text) NOT BETWEEN 1 AND 10 OR actor_text !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION USING ERRCODE = 'R4011', MESSAGE = 'Reservation actor context required.';
  END IF;
  IF actor_text::bigint > 2147483647 THEN
    RAISE EXCEPTION USING ERRCODE = 'R4011', MESSAGE = 'Reservation actor context required.';
  END IF;
  actor := actor_text::integer;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE user_id = actor AND is_active) THEN
    RAISE EXCEPTION USING ERRCODE = 'R4011', MESSAGE = 'Reservation actor context required.';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    before_value := pg_catalog.jsonb_build_object(
      'reservation_id', OLD.reservation_id, 'facility_id', OLD.facility_id,
      'requested_by', OLD.requested_by, 'approved_by', OLD.approved_by, 'status_id', OLD.status_id,
      'start_datetime', pg_catalog.to_char(OLD.start_datetime AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'end_datetime', pg_catalog.to_char(OLD.end_datetime AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'created_at', pg_catalog.to_char(OLD.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  END IF;
  IF TG_OP <> 'DELETE' THEN
    after_value := pg_catalog.jsonb_build_object(
      'reservation_id', NEW.reservation_id, 'facility_id', NEW.facility_id,
      'requested_by', NEW.requested_by, 'approved_by', NEW.approved_by, 'status_id', NEW.status_id,
      'start_datetime', pg_catalog.to_char(NEW.start_datetime AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'end_datetime', pg_catalog.to_char(NEW.end_datetime AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'created_at', pg_catalog.to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  END IF;
  INSERT INTO public.audit_logs (table_name, record_id, action_type, changed_by, old_value, new_value)
    VALUES ('reservations', CASE WHEN TG_OP = 'DELETE' THEN OLD.reservation_id ELSE NEW.reservation_id END,
      TG_OP, actor, before_value, after_value);
  RETURN NULL;
END
$audit$;
REVOKE ALL ON FUNCTION im101_private.audit_reservation() FROM PUBLIC;
GRANT CREATE ON SCHEMA im101_private TO im101_reservation_audit_writer;
ALTER FUNCTION im101_private.audit_reservation() OWNER TO im101_reservation_audit_writer;
REVOKE CREATE ON SCHEMA im101_private FROM im101_reservation_audit_writer;
CREATE TRIGGER reservation_audit AFTER INSERT OR UPDATE OR DELETE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION im101_private.audit_reservation();
COMMIT;
