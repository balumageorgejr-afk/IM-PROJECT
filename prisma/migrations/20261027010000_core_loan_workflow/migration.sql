-- Offline artifact only. Fresh dedicated NOLOGIN roles are deployment prerequisites.
BEGIN;
DO $preflight$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['im101_core_owner','im101_core_runtime','im101_core_audit_writer'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=name AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member WHERE r.rolname=name)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE r.rolname=name AND c.relnamespace='public'::regnamespace) THEN
   RAISE EXCEPTION USING ERRCODE='C4091',MESSAGE='Core deployment prerequisites not satisfied.';
  END IF;
 END LOOP;
 IF pg_catalog.has_table_privilege('im101_core_runtime','public.audit_logs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR pg_catalog.has_any_column_privilege('im101_core_runtime','public.audit_logs','SELECT,INSERT,UPDATE') OR pg_catalog.has_schema_privilege('im101_core_runtime','public','CREATE') THEN RAISE EXCEPTION USING ERRCODE='C4091',MESSAGE='Core deployment prerequisites not satisfied.'; END IF;
END $preflight$;
GRANT USAGE ON SCHEMA public,im101_private TO im101_core_owner,im101_core_runtime,im101_core_audit_writer;
GRANT SELECT(user_id,role_id,is_active),UPDATE(user_id) ON public.users TO im101_core_owner;
GRANT SELECT(role_id,role_name),UPDATE(role_id) ON public.roles TO im101_core_owner;
GRANT SELECT ON public.equipment_loans,public.loan_items,public.equipment TO im101_core_owner;
GRANT UPDATE(available_quantity,condition_status) ON public.equipment TO im101_core_owner;
GRANT UPDATE(condition_out) ON public.loan_items TO im101_core_owner;
GRANT UPDATE(loan_status) ON public.equipment_loans TO im101_core_owner;
GRANT SELECT,INSERT ON public.equipment_loans,public.loan_items TO im101_core_runtime;
GRANT UPDATE(loan_status,approved_by) ON public.equipment_loans TO im101_core_runtime;
GRANT UPDATE(condition_in) ON public.loan_items TO im101_core_runtime;
GRANT USAGE ON SEQUENCE public.equipment_loans_loan_id_seq TO im101_core_runtime;
GRANT CREATE ON SCHEMA im101_private TO im101_core_owner;
CREATE FUNCTION im101_private.core_actor() RETURNS TABLE(actor integer,role_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $actor$
DECLARE raw text;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN RAISE EXCEPTION USING ERRCODE='C4091',MESSAGE='Core transaction conflict.'; END IF;
 raw:=current_setting('im101.actor_id',true);
 IF raw IS NULL OR length(raw) NOT BETWEEN 1 AND 10 OR raw !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION USING ERRCODE='C4011',MESSAGE='Actor required.'; END IF;
 IF raw::bigint>2147483647 THEN RAISE EXCEPTION USING ERRCODE='C4011',MESSAGE='Actor required.'; END IF;
 RETURN QUERY SELECT u.user_id,r.role_name::text FROM public.users u JOIN public.roles r ON r.role_id=u.role_id WHERE u.user_id=raw::integer AND u.is_active FOR SHARE OF u,r;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='C4011',MESSAGE='Actor required.'; END IF;
END $actor$;
ALTER FUNCTION im101_private.core_actor() OWNER TO im101_core_owner;
REVOKE ALL ON FUNCTION im101_private.core_actor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION im101_private.core_actor() TO im101_core_runtime;
CREATE FUNCTION im101_private.loan_workflow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $loan$
DECLARE who record; item record; n integer:=0;
BEGIN
 IF TG_RELID<>'public.equipment_loans'::regclass OR TG_WHEN<>'BEFORE' THEN RAISE EXCEPTION USING ERRCODE='C4031',MESSAGE='Loan operation refused.'; END IF;
 SELECT * INTO who FROM im101_private.core_actor();
 IF who.role_name NOT IN('System Administrator','Facility/Maintenance Staff','Faculty / Student Organization Representative') THEN RAISE EXCEPTION USING ERRCODE='C4031',MESSAGE='Access denied.'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.user_id<>who.actor OR NEW.loan_status<>'Pending' OR NEW.approved_by IS NOT NULL OR NEW.return_date IS NOT NULL OR NEW.due_date IS NULL OR NOT isfinite(NEW.due_date) OR NEW.due_date<=clock_timestamp() OR NEW.due_date>clock_timestamp()+interval '90 days' THEN RAISE EXCEPTION USING ERRCODE='C4001',MESSAGE='Invalid loan input.'; END IF;
  NEW.requested_at:=clock_timestamp();RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.loan_id<>OLD.loan_id OR NEW.user_id<>OLD.user_id OR NEW.due_date<>OLD.due_date OR NEW.requested_at<>OLD.requested_at OR NEW.return_date IS DISTINCT FROM OLD.return_date THEN RAISE EXCEPTION USING ERRCODE='C4001',MESSAGE='Loan history is immutable.'; END IF;
 IF who.role_name NOT IN('System Administrator','Facility/Maintenance Staff') OR OLD.user_id=who.actor THEN RAISE EXCEPTION USING ERRCODE='C4031',MESSAGE='Access denied.'; END IF;
 IF NOT ((OLD.loan_status='Pending' AND NEW.loan_status IN('Approved','Rejected')) OR (OLD.loan_status='Approved' AND NEW.loan_status='Returned')) THEN RAISE EXCEPTION USING ERRCODE='C4091',MESSAGE='Loan transition conflict.'; END IF;
 IF NEW.loan_status='Rejected' THEN NEW.approved_by:=NULL;RETURN NEW; END IF;
 IF NEW.loan_status='Approved' THEN
  IF NEW.due_date<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='C4091',MESSAGE='Loan is overdue.'; END IF;
  NEW.approved_by:=who.actor;
 ELSE
  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN RAISE EXCEPTION USING ERRCODE='C4001',MESSAGE='Loan history is immutable.'; END IF;
  NEW.return_date:=clock_timestamp();
 END IF;
 FOR item IN SELECT li.*,e.total_quantity,e.available_quantity,e.condition_status FROM public.loan_items li JOIN public.equipment e USING(equipment_id) WHERE li.loan_id=OLD.loan_id ORDER BY e.equipment_id FOR UPDATE OF e LOOP
  n:=n+1;
  IF item.quantity<1 OR item.available_quantity<0 OR item.available_quantity>item.total_quantity THEN RAISE EXCEPTION USING ERRCODE='C4091',MESSAGE='Inventory requires reconciliation.'; END IF;
  IF NEW.loan_status='Approved' THEN
   IF item.condition_status<>'Good' OR item.available_quantity<item.quantity THEN RAISE EXCEPTION USING ERRCODE='C4091',MESSAGE='Equipment unavailable.'; END IF;
   UPDATE public.equipment SET available_quantity=available_quantity-item.quantity WHERE equipment_id=item.equipment_id;
   UPDATE public.loan_items SET condition_out=item.condition_status WHERE loan_id=OLD.loan_id AND equipment_id=item.equipment_id;
  ELSE
   IF item.condition_in IS NULL OR item.condition_in NOT IN('Good','Damaged') OR item.quantity>item.total_quantity-item.available_quantity THEN RAISE EXCEPTION USING ERRCODE='C4091',MESSAGE='Return requires reconciliation.'; END IF;
   UPDATE public.equipment SET available_quantity=available_quantity+item.quantity,condition_status=CASE WHEN item.condition_in='Damaged' THEN 'Damaged' ELSE condition_status END WHERE equipment_id=item.equipment_id;
  END IF;
 END LOOP;
 IF n=0 THEN RAISE EXCEPTION USING ERRCODE='C4091',MESSAGE='Loan has no items.'; END IF;
 RETURN NEW;
END $loan$;
ALTER FUNCTION im101_private.loan_workflow() OWNER TO im101_core_owner;
REVOKE ALL ON FUNCTION im101_private.loan_workflow() FROM PUBLIC;
CREATE TRIGGER loan_workflow BEFORE INSERT OR UPDATE ON public.equipment_loans FOR EACH ROW EXECUTE FUNCTION im101_private.loan_workflow();
CREATE FUNCTION im101_private.loan_item_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $item$
DECLARE who record; parent public.equipment_loans%ROWTYPE;
BEGIN
 IF TG_RELID<>'public.loan_items'::regclass THEN RAISE EXCEPTION USING ERRCODE='C4031',MESSAGE='Loan item operation refused.'; END IF;
 SELECT * INTO who FROM im101_private.core_actor();
 SELECT * INTO parent FROM public.equipment_loans WHERE loan_id=NEW.loan_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='C4041',MESSAGE='Loan not found.'; END IF;
 IF TG_OP='INSERT' THEN
  IF parent.user_id<>who.actor OR parent.loan_status<>'Pending' OR NEW.quantity<1 OR NEW.condition_out IS NOT NULL OR NEW.condition_in IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='C4001',MESSAGE='Invalid loan item.'; END IF;
 ELSE
  IF NEW.loan_id<>OLD.loan_id OR NEW.equipment_id<>OLD.equipment_id OR NEW.quantity<>OLD.quantity THEN RAISE EXCEPTION USING ERRCODE='C4001',MESSAGE='Loan item history is immutable.'; END IF;
  IF NEW.condition_out IS DISTINCT FROM OLD.condition_out THEN
   IF pg_trigger_depth()<2 OR who.role_name NOT IN('System Administrator','Facility/Maintenance Staff') OR parent.loan_status<>'Pending' THEN RAISE EXCEPTION USING ERRCODE='C4031',MESSAGE='Loan condition refused.'; END IF;
  ELSE
   IF parent.loan_status<>'Approved' OR parent.user_id=who.actor OR who.role_name NOT IN('System Administrator','Facility/Maintenance Staff') OR NEW.condition_in IS NULL OR NEW.condition_in NOT IN('Good','Damaged') THEN RAISE EXCEPTION USING ERRCODE='C4031',MESSAGE='Return condition refused.'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $item$;
ALTER FUNCTION im101_private.loan_item_guard() OWNER TO im101_core_owner;
REVOKE ALL ON FUNCTION im101_private.loan_item_guard() FROM PUBLIC;
CREATE TRIGGER loan_item_guard BEFORE INSERT OR UPDATE ON public.loan_items FOR EACH ROW EXECUTE FUNCTION im101_private.loan_item_guard();
CREATE FUNCTION im101_private.equipment_quantity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $bounds$
BEGIN
 IF NEW.total_quantity<0 OR NEW.available_quantity<0 OR NEW.available_quantity>NEW.total_quantity THEN RAISE EXCEPTION USING ERRCODE='C4091',MESSAGE='Inventory bounds refused.'; END IF;
 RETURN NEW;
END $bounds$;
ALTER FUNCTION im101_private.equipment_quantity_guard() OWNER TO im101_core_owner;
REVOKE ALL ON FUNCTION im101_private.equipment_quantity_guard() FROM PUBLIC;
CREATE TRIGGER equipment_quantity_guard BEFORE INSERT OR UPDATE ON public.equipment FOR EACH ROW EXECUTE FUNCTION im101_private.equipment_quantity_guard();
REVOKE CREATE ON SCHEMA im101_private FROM im101_core_owner;
COMMIT;
