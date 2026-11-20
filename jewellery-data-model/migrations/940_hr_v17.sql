-- 940_hr_v17.sql — hr.staff PAN: ciphertext + key id + last4 (all or none), aadhaar_last4 format (v1.7).
ALTER TABLE hr.staff
  ADD COLUMN pan_key_id text CONSTRAINT staff_pan_key_id_check CHECK (pan_key_id ~ '^[a-z0-9._-]{1,40}$'),
  ADD COLUMN pan_last4 varchar(4) CONSTRAINT staff_pan_last4_check CHECK (pan_last4 ~ '^[0-9A-Z]{4}$'),
  ADD CONSTRAINT staff_aadhaar_last4_check CHECK (aadhaar_last4 ~ '^[0-9]{4}$'),
  ADD CONSTRAINT staff_pan_all_or_none     CHECK ((pan_enc IS NULL) = (pan_key_id IS NULL) AND (pan_enc IS NULL) = (pan_last4 IS NULL)),
  ADD CONSTRAINT staff_pan_ciphertext      CHECK (pan_enc IS NULL OR (octet_length(pan_enc) >= 28 AND encode(pan_enc, 'hex') !~ '^([2-7][0-9a-f])*$'));
