-- Offline artifact. Existing data is never deleted or rewritten; duplicate active keys fail installation.
BEGIN;
GRANT SELECT ON public.maintenance_requests,public.maintenance_logs,public.facility_staff_assignments,public.facilities TO im101_core_owner;
GRANT SELECT,INSERT ON public.maintenance_requests,public.maintenance_logs,public.facility_staff_assignments TO im101_core_runtime;
GRANT UPDATE(assigned_staff_id,priority,status,resolved_at) ON public.maintenance_requests TO im101_core_runtime;
GRANT UPDATE(assigned_role,shift,unassigned_date) ON public.facility_staff_assignments TO im101_core_runtime;
GRANT USAGE ON SEQUENCE public.maintenance_requests_request_id_seq,public.maintenance_logs_log_id_seq,public.facility_staff_assignments_assignment_id_seq TO im101_core_runtime;
GRANT CREATE ON SCHEMA im101_private TO im101_core_owner;
CREATE FUNCTION im101_private.core_staff(p_staff integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $staff$
BEGIN
 PERFORM u.user_id FROM public.users u JOIN public.roles r ON r.role_id=u.role_id WHERE u.user_id=p_staff AND u.is_active AND r.role_name='Facility/Maintenance Staff' FOR SHARE OF u,r;
 RETURN FOUND;
END $staff$;
ALTER FUNCTION im101_private.core_staff(integer) OWNER TO im101_core_owner;
REVOKE ALL ON FUNCTION im101_private.core_staff(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION im101_private.core_staff(integer) TO im101_core_runtime;
CREATE FUNCTION im101_private.maintenance_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $request$
DECLARE who record;
BEGIN
 IF TG_RELID<>'public.maintenance_requests'::regclass THEN RAISE EXCEPTION USING ERRCODE='C4031',MESSAGE='Maintenance operation refused.'; END IF;
 SELECT * INTO who FROM im101_private.core_actor();
 IF NEW.priority NOT IN('Low','Normal','High') OR char_length(btrim(NEW.description)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION USING ERRCODE='C4001',MESSAGE='Invalid maintenance input.'; END IF;
 IF TG_OP='INSERT' THEN
  IF who.role_name NOT IN('System Administrator','Facility/Maintenance Staff','Faculty / Student Organization Representative') OR NEW.reported_by IS DISTINCT FROM who.actor OR (NEW.facility_id IS NULL)=(NEW.equipment_id IS NULL) OR NEW.status<>'Open' OR NEW.assigned_staff_id IS NOT NULL OR NEW.resolved_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='C4001',MESSAGE='Invalid maintenance input.'; END IF;
  NEW.reported_at:=clock_timestamp();RETURN NEW;
 END IF;
 IF NEW.request_id<>OLD.request_id OR NEW.facility_id IS DISTINCT FROM OLD.facility_id OR NEW.equipment_id IS DISTINCT FROM OLD.equipment_id OR NEW.reported_by IS DISTINCT FROM OLD.reported_by OR NEW.description<>OLD.description OR NEW.reported_at<>OLD.reported_at THEN RAISE EXCEPTION USING ERRCODE='C4001',MESSAGE='Maintenance history is immutable.'; END IF;
 IF OLD.status NOT IN('Open','In Progress') THEN RAISE EXCEPTION USING ERRCODE='C4091',MESSAGE='Maintenance already resolved.'; END IF;
 IF who.role_name<>'System Administrator' THEN
  IF who.role_name<>'Facility/Maintenance Staff' OR (NEW.assigned_staff_id IS DISTINCT FROM OLD.assigned_staff_id AND (OLD.assigned_staff_id IS NOT NULL OR NEW.assigned_staff_id IS DISTINCT FROM who.actor)) OR (NEW.assigned_staff_id IS NOT DISTINCT FROM OLD.assigned_staff_id AND OLD.assigned_staff_id IS DISTINCT FROM who.actor) THEN RAISE EXCEPTION USING ERRCODE='C4031',MESSAGE='Access denied.'; END IF;
 END IF;
 IF NEW.assigned_staff_id IS NOT NULL AND NOT im101_private.core_staff(NEW.assigned_staff_id) THEN RAISE EXCEPTION USING ERRCODE='C4001',MESSAGE='Eligible staff required.'; END IF;
 IF NOT(NEW.status=OLD.status OR OLD.status='Open' AND NEW.status='In Progress' OR OLD.status='In Progress' AND NEW.status='Resolved') THEN RAISE EXCEPTION USING ERRCODE='C4091',MESSAGE='Maintenance transition conflict.'; END IF;
 IF NEW.status='Resolved' THEN NEW.resolved_at:=clock_timestamp(); ELSE IF NEW.resolved_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='C4001',MESSAGE='Invalid resolution time.'; END IF; END IF;
 RETURN NEW;
END $request$;
ALTER FUNCTION im101_private.maintenance_guard() OWNER TO im101_core_owner;
REVOKE ALL ON FUNCTION im101_private.maintenance_guard() FROM PUBLIC;
CREATE TRIGGER maintenance_guard BEFORE INSERT OR UPDATE ON public.maintenance_requests FOR EACH ROW EXECUTE FUNCTION im101_private.maintenance_guard();
CREATE FUNCTION im101_private.maintenance_log_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $log$
DECLARE who record; assigned integer;
BEGIN
 SELECT * INTO who FROM im101_private.core_actor();
 SELECT assigned_staff_id INTO assigned FROM public.maintenance_requests WHERE request_id=NEW.request_id;
 IF NOT FOUND OR NEW.staff_id IS DISTINCT FROM who.actor OR who.role_name NOT IN('System Administrator','Facility/Maintenance Staff') OR (who.role_name<>'System Administrator' AND assigned IS DISTINCT FROM who.actor) OR char_length(btrim(NEW.action_taken)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION USING ERRCODE='C4031',MESSAGE='Maintenance log refused.'; END IF;
 NEW.logged_at:=clock_timestamp();RETURN NEW;
END $log$;
ALTER FUNCTION im101_private.maintenance_log_guard() OWNER TO im101_core_owner;
REVOKE ALL ON FUNCTION im101_private.maintenance_log_guard() FROM PUBLIC;
CREATE TRIGGER maintenance_log_guard BEFORE INSERT ON public.maintenance_logs FOR EACH ROW EXECUTE FUNCTION im101_private.maintenance_log_guard();
CREATE FUNCTION im101_private.assignment_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $assignment$
DECLARE who record;
BEGIN
 SELECT * INTO who FROM im101_private.core_actor();
 IF who.role_name<>'System Administrator' THEN RAISE EXCEPTION USING ERRCODE='C4031',MESSAGE='Access denied.'; END IF;
 IF NEW.assigned_role NOT IN('Custodian','Maintenance Technician') OR NEW.shift IS NOT NULL AND NEW.shift NOT IN('Day','Evening','Night') OR ((TG_OP='INSERT' OR NEW.unassigned_date IS NULL) AND NOT im101_private.core_staff(NEW.staff_id)) OR NEW.assigned_date>CURRENT_DATE OR NEW.unassigned_date IS NOT NULL AND (NEW.unassigned_date<NEW.assigned_date OR NEW.unassigned_date>CURRENT_DATE) THEN RAISE EXCEPTION USING ERRCODE='C4001',MESSAGE='Invalid assignment input.'; END IF;
 IF TG_OP='UPDATE' AND (OLD.unassigned_date IS NOT NULL OR NEW.assignment_id<>OLD.assignment_id OR NEW.facility_id<>OLD.facility_id OR NEW.staff_id<>OLD.staff_id OR NEW.assigned_date<>OLD.assigned_date) THEN RAISE EXCEPTION USING ERRCODE='C4091',MESSAGE='Assignment history is immutable.'; END IF;
 RETURN NEW;
END $assignment$;
ALTER FUNCTION im101_private.assignment_guard() OWNER TO im101_core_owner;
REVOKE ALL ON FUNCTION im101_private.assignment_guard() FROM PUBLIC;
CREATE TRIGGER assignment_guard BEFORE INSERT OR UPDATE ON public.facility_staff_assignments FOR EACH ROW EXECUTE FUNCTION im101_private.assignment_guard();
CREATE UNIQUE INDEX facility_staff_active_unique ON public.facility_staff_assignments(facility_id,staff_id,assigned_role) WHERE unassigned_date IS NULL;
REVOKE CREATE ON SCHEMA im101_private FROM im101_core_owner;
COMMIT;
