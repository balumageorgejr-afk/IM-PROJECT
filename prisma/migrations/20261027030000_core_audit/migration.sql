-- Allowlisted parent/scalar-key audits only. Composite loan_items audit convention is deferred.
BEGIN;
GRANT INSERT(table_name,record_id,action_type,changed_by,old_value,new_value) ON public.audit_logs TO im101_core_audit_writer;
GRANT USAGE ON SEQUENCE public.audit_logs_log_id_seq TO im101_core_audit_writer;
GRANT SELECT(user_id,is_active) ON public.users TO im101_core_audit_writer;
CREATE FUNCTION im101_private.audit_core() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $audit$
DECLARE raw text; actor integer; record_key integer; before_value jsonb; after_value jsonb;
BEGIN
 IF TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','UPDATE','DELETE') THEN RAISE EXCEPTION USING ERRCODE='C4031',MESSAGE='Core audit refused.'; END IF;
 raw:=current_setting('im101.actor_id',true);
 IF raw IS NULL OR length(raw) NOT BETWEEN 1 AND 10 OR raw !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION USING ERRCODE='C4011',MESSAGE='Actor required.'; END IF;
 IF raw::bigint>2147483647 THEN RAISE EXCEPTION USING ERRCODE='C4011',MESSAGE='Actor required.'; END IF;
 actor:=raw::integer;
 IF NOT EXISTS(SELECT 1 FROM public.users WHERE user_id=actor AND is_active) THEN RAISE EXCEPTION USING ERRCODE='C4011',MESSAGE='Actor required.'; END IF;
 IF TG_RELID='public.equipment_loans'::regclass THEN
 record_key:=CASE WHEN TG_OP='DELETE' THEN OLD.loan_id ELSE NEW.loan_id END;
 IF TG_OP<>'INSERT' THEN before_value:=jsonb_build_object('loan_id',OLD.loan_id,'user_id',OLD.user_id,'approved_by',OLD.approved_by,'requested_at',OLD.requested_at,'due_date',OLD.due_date,'return_date',OLD.return_date,'loan_status',OLD.loan_status); END IF;
 IF TG_OP<>'DELETE' THEN after_value:=jsonb_build_object('loan_id',NEW.loan_id,'user_id',NEW.user_id,'approved_by',NEW.approved_by,'requested_at',NEW.requested_at,'due_date',NEW.due_date,'return_date',NEW.return_date,'loan_status',NEW.loan_status); END IF;
ELSIF TG_RELID='public.maintenance_requests'::regclass THEN
 record_key:=CASE WHEN TG_OP='DELETE' THEN OLD.request_id ELSE NEW.request_id END;
 IF TG_OP<>'INSERT' THEN before_value:=jsonb_build_object('request_id',OLD.request_id,'facility_id',OLD.facility_id,'equipment_id',OLD.equipment_id,'reported_by',OLD.reported_by,'assigned_staff_id',OLD.assigned_staff_id,'priority',OLD.priority,'status',OLD.status,'reported_at',OLD.reported_at,'resolved_at',OLD.resolved_at); END IF;
 IF TG_OP<>'DELETE' THEN after_value:=jsonb_build_object('request_id',NEW.request_id,'facility_id',NEW.facility_id,'equipment_id',NEW.equipment_id,'reported_by',NEW.reported_by,'assigned_staff_id',NEW.assigned_staff_id,'priority',NEW.priority,'status',NEW.status,'reported_at',NEW.reported_at,'resolved_at',NEW.resolved_at); END IF;
ELSIF TG_RELID='public.maintenance_logs'::regclass THEN
 record_key:=CASE WHEN TG_OP='DELETE' THEN OLD.log_id ELSE NEW.log_id END;
 IF TG_OP<>'INSERT' THEN before_value:=jsonb_build_object('log_id',OLD.log_id,'request_id',OLD.request_id,'staff_id',OLD.staff_id,'logged_at',OLD.logged_at); END IF;
 IF TG_OP<>'DELETE' THEN after_value:=jsonb_build_object('log_id',NEW.log_id,'request_id',NEW.request_id,'staff_id',NEW.staff_id,'logged_at',NEW.logged_at); END IF;
ELSIF TG_RELID='public.facility_staff_assignments'::regclass THEN
 record_key:=CASE WHEN TG_OP='DELETE' THEN OLD.assignment_id ELSE NEW.assignment_id END;
 IF TG_OP<>'INSERT' THEN before_value:=jsonb_build_object('assignment_id',OLD.assignment_id,'facility_id',OLD.facility_id,'staff_id',OLD.staff_id,'assigned_role',OLD.assigned_role,'shift',OLD.shift,'assigned_date',OLD.assigned_date,'unassigned_date',OLD.unassigned_date); END IF;
 IF TG_OP<>'DELETE' THEN after_value:=jsonb_build_object('assignment_id',NEW.assignment_id,'facility_id',NEW.facility_id,'staff_id',NEW.staff_id,'assigned_role',NEW.assigned_role,'shift',NEW.shift,'assigned_date',NEW.assigned_date,'unassigned_date',NEW.unassigned_date); END IF;
 ELSE RAISE EXCEPTION USING ERRCODE='C4031',MESSAGE='Core audit refused.'; END IF;
 INSERT INTO public.audit_logs(table_name,record_id,action_type,changed_by,old_value,new_value) VALUES(TG_TABLE_NAME,record_key,TG_OP,actor,before_value,after_value);
 RETURN NULL;
END $audit$;
REVOKE ALL ON FUNCTION im101_private.audit_core() FROM PUBLIC;
GRANT CREATE ON SCHEMA im101_private TO im101_core_audit_writer;
ALTER FUNCTION im101_private.audit_core() OWNER TO im101_core_audit_writer;
REVOKE CREATE ON SCHEMA im101_private FROM im101_core_audit_writer;
CREATE TRIGGER core_audit AFTER INSERT OR UPDATE OR DELETE ON public.equipment_loans FOR EACH ROW EXECUTE FUNCTION im101_private.audit_core();
CREATE TRIGGER core_audit AFTER INSERT OR UPDATE OR DELETE ON public.maintenance_requests FOR EACH ROW EXECUTE FUNCTION im101_private.audit_core();
CREATE TRIGGER core_audit AFTER INSERT OR UPDATE OR DELETE ON public.maintenance_logs FOR EACH ROW EXECUTE FUNCTION im101_private.audit_core();
CREATE TRIGGER core_audit AFTER INSERT OR UPDATE OR DELETE ON public.facility_staff_assignments FOR EACH ROW EXECUTE FUNCTION im101_private.audit_core();
COMMIT;
