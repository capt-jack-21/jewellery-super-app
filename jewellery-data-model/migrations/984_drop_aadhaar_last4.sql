-- 984_drop_aadhaar_last4.sql — no Aadhaar data at all (Adithya, 2026-10-28).
-- Drops aadhaar_last4 from masters.customer (040; format check 930), hr.staff (060; check 940) and masters.vendor (979).
-- Their format CHECKs and column-level grants (960 v1.7 / 979 column grants) go with the columns. No view, function,
-- index or other object depends on them (a dependency would make the plain DROP COLUMN fail, which is intended).
-- The KYC document type already excludes 'aadhaar' (983).
-- Dev check 2026-10-28 (read only, 5 demo tenants): 0 non-null aadhaar_last4 in customer and staff.
-- Guard: refuses to drop if the current session can see any non-null value (RLS limits this to app.tenant_id's tenant).
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM masters.customer WHERE aadhaar_last4 IS NOT NULL)
       + (SELECT count(*) FROM hr.staff WHERE aadhaar_last4 IS NOT NULL)
       + (SELECT count(*) FROM masters.vendor WHERE aadhaar_last4 IS NOT NULL) INTO n;
  IF n > 0 THEN RAISE EXCEPTION '984: % visible row(s) still hold aadhaar_last4; clear them deliberately before dropping', n; END IF;
END $$;

ALTER TABLE masters.customer DROP CONSTRAINT customer_aadhaar_last4_check;
ALTER TABLE masters.customer DROP COLUMN aadhaar_last4;
ALTER TABLE hr.staff DROP CONSTRAINT staff_aadhaar_last4_check;
ALTER TABLE hr.staff DROP COLUMN aadhaar_last4;
ALTER TABLE masters.vendor DROP CONSTRAINT vendor_aadhaar_last4_check;
ALTER TABLE masters.vendor DROP COLUMN aadhaar_last4;

-- ---------- masters.kyc.reveal (Ironhide): reveal a decrypted KYC/PAN value; owner + manager only (982 pattern) ----------
INSERT INTO platform.permission(code, module, description) VALUES ('masters.kyc.reveal', 'masters', 'Reveal full KYC / PAN numbers (audited)');
INSERT INTO platform.system_role_permission(role_code, permission_code) VALUES ('owner', 'masters.kyc.reveal'), ('manager', 'masters.kyc.reveal');
-- Audit of a reveal: platform.audit_event.action is free text (no CHECK/enum), so nothing to widen. The app calls the
-- approved writer platform.audit_append(p_tenant uuid, p_action text, p_table text, p_row uuid, p_old jsonb, p_new jsonb)
-- (app_rw has EXECUTE since 900/960) with action 'kyc.reveal' and new_row = {"field": ..., "reason": ...}: never the value.

-- ---------- hr.staff free-text department / designation (alongside the existing department_id / designation_id FKs) ----------
ALTER TABLE hr.staff
  ADD COLUMN department  text CONSTRAINT staff_department_len  CHECK (char_length(department)  BETWEEN 1 AND 100),
  ADD COLUMN designation text CONSTRAINT staff_designation_len CHECK (char_length(designation) BETWEEN 1 AND 100);
-- app_rw has table-level DML on hr (960); readers hold column-level SELECT on hr.staff (960 v1.7, 979): extend it.
DO $$
DECLARE g record;
BEGIN
  FOR g IN SELECT DISTINCT a.grantee::regrole::text AS role
           FROM pg_attribute att, aclexplode(att.attacl) a
           WHERE att.attrelid = 'hr.staff'::regclass AND att.attname = 'name' AND a.privilege_type = 'SELECT'
             AND a.grantee <> 0 AND a.grantee::regrole::text NOT IN ('app_rw','app_migrator')
  LOOP
    EXECUTE format('GRANT SELECT (department, designation) ON hr.staff TO %I', g.role);
  END LOOP;
END $$;
