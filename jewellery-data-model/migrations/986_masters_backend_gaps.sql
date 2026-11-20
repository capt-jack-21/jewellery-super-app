-- 986_masters_backend_gaps.sql — small backend-driven gaps (Ironhide), after 985.
--  1. platform.rate_limit_bucket.bucket_key also allows 'kyc.reveal:<tenant uuid>:<user uuid>' (throttle KYC reveals).
--  2. platform.file soft delete: NOTHING to add. 974 (applied) already grants app_rw SELECT, INSERT and
--     UPDATE (deleted_at); nothing later revokes it (tests F12/F13 cover it).
--  3. hr.staff.department_id / designation_id: deprecated by comment only (free-text department/designation from 984);
--     not dropped (data loss needs approval).
--  4. is_active boolean NOT NULL DEFAULT true on accounts.cash_counter, hr.department, hr.designation
--     (existing rows become active). Grants unchanged: table-level grants already cover new columns.
--  5. import_job, import_mapping_profile and export_job kinds += 'floors' (981 already has 'bank_accounts'); 981's plural style.

-- 1.
ALTER TABLE platform.rate_limit_bucket DROP CONSTRAINT rate_limit_bucket_bucket_key_check;
ALTER TABLE platform.rate_limit_bucket ADD CONSTRAINT rate_limit_bucket_bucket_key_check CHECK (bucket_key ~
  '^((login\.(tenant|partner|admin)|otp\.(send|verify)):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|-):([0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|kyc\.reveal:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');

-- 3.
COMMENT ON COLUMN hr.staff.department_id  IS 'DEPRECATED (986): use hr.staff.department (free text, 984). Kept for existing data; do not write.';
COMMENT ON COLUMN hr.staff.designation_id IS 'DEPRECATED (986): use hr.staff.designation (free text, 984). Kept for existing data; do not write.';

-- 4.
ALTER TABLE accounts.cash_counter ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE hr.department         ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE hr.designation        ADD COLUMN is_active boolean NOT NULL DEFAULT true;

-- 5.
ALTER TABLE platform.import_job DROP CONSTRAINT import_job_kind_check;
ALTER TABLE platform.import_job ADD CONSTRAINT import_job_kind_check CHECK (kind IN (
  'customers','stock','opening_balances',
  'metals','purities','items','sub_items','designs','stones','stone_rates','making_wastage_rules',
  'vendors','staff','counters','floors','trays','hsn_codes','payment_modes','bank_accounts','card_machines'));
ALTER TABLE platform.import_mapping_profile DROP CONSTRAINT import_mapping_profile_kind_check;
ALTER TABLE platform.import_mapping_profile ADD CONSTRAINT import_mapping_profile_kind_check CHECK (kind IN (
  'customers','stock','opening_balances',
  'metals','purities','items','sub_items','designs','stones','stone_rates','making_wastage_rules',
  'vendors','staff','counters','floors','trays','hsn_codes','payment_modes','bank_accounts','card_machines'));
ALTER TABLE platform.export_job DROP CONSTRAINT export_job_kind_check;
ALTER TABLE platform.export_job ADD CONSTRAINT export_job_kind_check CHECK (kind IN (
  'customers','stock','opening_balances',
  'metals','purities','items','sub_items','designs','stones','stone_rates','making_wastage_rules',
  'vendors','staff','counters','floors','trays','hsn_codes','payment_modes','bank_accounts','card_machines'));
