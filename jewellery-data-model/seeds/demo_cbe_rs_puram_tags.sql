-- seeds/demo_cbe_rs_puram_tags.sql — ~9 in_stock tagged pieces at RS Puram (branch CBE) of demo-cbe-sri-valli only.
-- Data only, one transaction, idempotent (tag_no DEMO-RSP-01..09; INSERT … WHERE NOT EXISTS). Aborts if the slug or
-- branch is missing. Uses existing demo masters (item + purity); does not create metals/items or touch other tenants.
-- Login: app_rw privileges (dev_seed). NOT for unapproved dev runs — Adithya's OK through Ultra Magnus required for dev.
--   psql -X -q -v ON_ERROR_STOP=1 -f seeds/demo_cbe_rs_puram_tags.sql
\set ON_ERROR_STOP 1
BEGIN;
DO $$
DECLARE
  t uuid;
  br uuid;
  cnt_gold uuid;
  cnt_silv uuid;
  n int := 0;
  r_ins int;
  piece record;
BEGIN
  PERFORM set_config('app.partner_id', '', true);
  SELECT tenant_id INTO t FROM platform.resolve_tenant('demo-cbe-sri-valli');
  IF t IS NULL THEN
    RAISE EXCEPTION 'unknown tenant slug demo-cbe-sri-valli (run seeds/dev_demo_5_shops.sql / run_demo_seed.sh first)';
  END IF;
  PERFORM set_config('app.tenant_id', t::text, true);

  SELECT id INTO br FROM platform.branch WHERE tenant_id = t AND code = 'CBE';
  IF br IS NULL THEN
    RAISE EXCEPTION 'demo-cbe-sri-valli has no branch code CBE (RS Puram)';
  END IF;

  SELECT id INTO cnt_gold FROM masters.counter WHERE tenant_id = t AND branch_id = br AND code = 'GOLD1';
  SELECT id INTO cnt_silv FROM masters.counter WHERE tenant_id = t AND branch_id = br AND code = 'SILVER';

  -- Fixed catalogue of demo pieces: tag_no, item code, purity code, gross, net, pieces, mc_type, mc_value, huid|NULL, hallmark_exempt
  -- Spread: 22K gold (RING/CHAIN/BANGLE), 18K gold (STUD18), 925 silver (ANKLET). COIN24 is non_tag — skipped.
  FOR piece IN
    SELECT * FROM (VALUES
      ('DEMO-RSP-01', 'RING',   '22K', 3.200::numeric, 3.000::numeric, 1, 'per_gram', 450.00::numeric, 'DMRSP1', false),
      ('DEMO-RSP-02', 'RING',   '22K', 2.850,           2.700,           1, 'per_gram', 450.00,           'DMRSP2', false),
      ('DEMO-RSP-03', 'CHAIN',  '22K', 8.500,           8.200,           1, 'percent',  12.00,            'DMRSP3', false),
      ('DEMO-RSP-04', 'CHAIN',  '22K', 12.000,          11.600,          1, 'percent',  12.00,            'DMRSP4', false),
      ('DEMO-RSP-05', 'BANGLE', '22K', 15.400,          15.000,          2, 'per_gram', 380.00,           'DMRSP5', false),
      ('DEMO-RSP-06', 'STUD18', '18K', 1.800,           1.600,           2, 'flat',     1500.00,          'DMRSP6', false),
      ('DEMO-RSP-07', 'STUD18', '18K', 2.100,           1.900,           2, 'flat',     1500.00,          'DMRSP7', false),
      ('DEMO-RSP-08', 'ANKLET', '925', 18.500,          18.500,          1, 'per_gram', 25.00,            NULL,     true),
      ('DEMO-RSP-09', 'ANKLET', '925', 22.000,          22.000,          1, 'per_gram', 25.00,            NULL,     true)
    ) v(tag_no, item_code, purity_code, gross_wt, net_wt, pieces, mc_type, mc_value, huid, hallmark_exempt)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM masters.item i WHERE i.tenant_id = t AND i.code = piece.item_code) THEN
      RAISE EXCEPTION 'demo-cbe-sri-valli missing item % (demo masters incomplete)', piece.item_code;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM masters.item i JOIN masters.purity p ON p.tenant_id = i.tenant_id AND p.id = i.purity_id
      WHERE i.tenant_id = t AND i.code = piece.item_code AND p.code = piece.purity_code
    ) THEN
      RAISE EXCEPTION 'demo-cbe-sri-valli item % not on purity %', piece.item_code, piece.purity_code;
    END IF;

    INSERT INTO inventory.tag(
      tenant_id, branch_id, tag_no, item_id, purity_id, huid, hallmark_exempt,
      pieces, gross_wt, stone_wt, net_wt, counter_id, mc_type, mc_value, status
    )
    SELECT t, br, piece.tag_no, i.id, p.id, piece.huid, piece.hallmark_exempt,
           piece.pieces, piece.gross_wt, 0, piece.net_wt,
           CASE WHEN piece.purity_code = '925' THEN cnt_silv ELSE cnt_gold END,
           piece.mc_type, piece.mc_value, 'in_stock'
    FROM masters.item i
    JOIN masters.purity p ON p.tenant_id = i.tenant_id AND p.id = i.purity_id AND p.code = piece.purity_code
    WHERE i.tenant_id = t AND i.code = piece.item_code
      AND NOT EXISTS (SELECT 1 FROM inventory.tag x WHERE x.tenant_id = t AND x.tag_no = piece.tag_no);
    GET DIAGNOSTICS r_ins = ROW_COUNT;
    n := n + r_ins;
  END LOOP;

  RAISE NOTICE 'demo_cbe_rs_puram_tags: % inserted (9 planned; already-present skipped); branch CBE / RS Puram only', n;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
COMMIT;
