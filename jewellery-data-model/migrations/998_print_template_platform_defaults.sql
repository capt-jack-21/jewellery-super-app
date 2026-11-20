-- 998_print_template_platform_defaults.sql — published PLATFORM print-template defaults (fixed UUIDv7 pins).
-- TEST DB ONLY until approved for deploy. 991–997 and applied migrations remain unchanged.
-- No new schema objects / grants / functions / triggers; document_print.template_id/template_version stay nullable.
-- Platform scope means BOTH tenant_id and partner_id NULL (015 scope CHECK). en exists in platform.language (950).
-- app_migrator's platform_writer membership satisfies forced RLS; aa_version sets row_version=1 (not document version).
-- zz_audit intentionally skips platform rows (tenant_id NULL), per 015: no tenant audit-chain entry is manufactured.
--
-- UUIDv7 values generated ONCE and hard-coded below: immutable frontend id/version pins (do not regenerate at deploy).
-- Conflict policy is FAIL LOUDLY, not silent adoption: a different existing platform v1 ID would break published asset pins.
-- Also fail if another platform version is active, or a published ID already has different content. Never deactivate/overwrite,
-- renumber or delete an existing template; reconcile such a DB in a separately approved step. Tenant/partner overrides untouched.
-- One atomic DO statement (also safe under psql autocommit). Short table lock serializes guard + insert with template writes;
-- ON CONFLICT (id) DO NOTHING handles exact reruns without touching created_at, row_version, config or audit.
DO $$
DECLARE p record; other_id uuid;
BEGIN
  LOCK TABLE branding.print_template IN SHARE ROW EXCLUSIVE MODE;
  FOR p IN SELECT * FROM (VALUES
    ('01a1c455-29fa-769b-84f9-377a9bcdab46'::uuid,'invoice','tpl/platform/invoice.hbs'),
    ('01a1c455-29fa-7963-88e9-d3cf6e2a8240'::uuid,'estimate','tpl/platform/estimate.hbs'),
    ('01a1c455-29fa-7856-b4ed-a3710fd91ec1'::uuid,'credit_note','tpl/platform/credit_note.hbs'),
    ('01a1c455-29fa-7811-b4b1-95efbd5b9ea5'::uuid,'receipt','tpl/platform/receipt.hbs')
  ) v(id,doc_type,body_key) LOOP
    SELECT t.id INTO other_id FROM branding.print_template t
     WHERE t.scope='platform' AND t.partner_id IS NULL AND t.tenant_id IS NULL AND t.doc_type=p.doc_type AND t.version=1 AND t.id<>p.id;
    IF FOUND THEN
      RAISE EXCEPTION '998: conflicting platform % v1 id % (expected %); print_template_version_uq guard: no templates changed',p.doc_type,other_id,p.id
        USING HINT='Existing IDs may already be pinned. Reconcile explicitly before deploying 998; do not overwrite or silently substitute.';
    END IF;
    SELECT t.id INTO other_id FROM branding.print_template t
     WHERE t.scope='platform' AND t.partner_id IS NULL AND t.tenant_id IS NULL AND t.doc_type=p.doc_type AND t.is_active AND t.id<>p.id;
    IF FOUND THEN
      RAISE EXCEPTION '998: another platform % version is active (id %); print_template_one_active guard: no templates changed',p.doc_type,other_id;
    END IF;
    IF EXISTS(SELECT 1 FROM branding.print_template t WHERE t.id=p.id
       AND (t.scope,t.partner_id,t.tenant_id,t.doc_type,t.version,t.paper,t.print_language,t.numeral_system,t.engine,t.body_key,t.is_active)
           IS DISTINCT FROM ('platform'::text,NULL::uuid,NULL::uuid,p.doc_type,1,'A4'::text,'en'::text,'latin'::text,'handlebars'::text,p.body_key,true)) THEN
      RAISE EXCEPTION '998: published template id % has different values; no templates changed',p.id;
    END IF;
  END LOOP;
  INSERT INTO branding.print_template(id,scope,partner_id,tenant_id,doc_type,version,paper,print_language,numeral_system,engine,body_key,is_active)
  VALUES
    ('01a1c455-29fa-769b-84f9-377a9bcdab46','platform',NULL,NULL,'invoice',1,'A4','en','latin','handlebars','tpl/platform/invoice.hbs',true),
    ('01a1c455-29fa-7963-88e9-d3cf6e2a8240','platform',NULL,NULL,'estimate',1,'A4','en','latin','handlebars','tpl/platform/estimate.hbs',true),
    ('01a1c455-29fa-7856-b4ed-a3710fd91ec1','platform',NULL,NULL,'credit_note',1,'A4','en','latin','handlebars','tpl/platform/credit_note.hbs',true),
    ('01a1c455-29fa-7811-b4b1-95efbd5b9ea5','platform',NULL,NULL,'receipt',1,'A4','en','latin','handlebars','tpl/platform/receipt.hbs',true)
  ON CONFLICT (id) DO NOTHING;
  -- Fail closed on even an RLS-hidden UUID collision (PK DO NOTHING must not silently omit a published default).
  IF (SELECT count(*) FROM branding.print_template WHERE scope='platform' AND partner_id IS NULL AND tenant_id IS NULL AND version=1 AND is_active
       AND id IN ('01a1c455-29fa-769b-84f9-377a9bcdab46','01a1c455-29fa-7963-88e9-d3cf6e2a8240','01a1c455-29fa-7856-b4ed-a3710fd91ec1','01a1c455-29fa-7811-b4b1-95efbd5b9ea5'))<>4 THEN
    RAISE EXCEPTION '998: could not install all four published platform defaults; no templates changed';
  END IF;
END $$;
