-- seeds/dev_demo_5_shops.sql — DEV/TEST DEMO DATA ONLY (5 Tamil Nadu shops + 1 demo partner). Data only, no DDL.
-- Run as app_migrator (RLS forced; app.tenant_id is set per shop) inside one transaction:
--   psql -v ON_ERROR_STOP=1 -v pwhash="$HASH" -f seeds/dev_demo_5_shops.sql
-- :pwhash is an argon2id hash (backend params: m=19456, t=2, p=1) of the shared demo password; the plaintext
-- never reaches this file. Use seeds/run_demo_seed.sh, which generates the password and writes the logins file.
-- Demo markers: every tenant/partner slug starts with 'demo-'; company.address / onboarding details carry {"demo":true};
-- every username starts with 'demo.'; every partner_user email is @demo.invalid.
-- Idempotent: a shop whose slug exists is not re-provisioned; every other row is "insert if missing";
-- password hashes of all demo logins are reset to :pwhash on every run. No invoices, no PAN/Aadhaar.
\set ON_ERROR_STOP 1
BEGIN;
SELECT set_config('demo.pwhash', :'pwhash', true) \g /dev/null
DO $$ BEGIN
  IF current_setting('demo.pwhash') !~ '^\$argon2id\$v=19\$m=19456,t=2,p=1\$' THEN
    RAISE EXCEPTION 'pwhash must be an argon2id hash with the backend params';
  END IF;
  IF current_user IN ('app_rw','app_ro') THEN
    RAISE EXCEPTION 'run as app_migrator, not the API role';
  END IF;
END $$;

DO $seed$
DECLARE
  h  text := current_setting('demo.pwhash');
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_partner uuid;
  s jsonb; b jsonb; u jsonb; x jsonb;
  t uuid; comp uuid; br uuid; br1 uuid; uid uuid; m_gold uuid; m_silver uuid; pur uuid; it uuid; cnt uuid; grp uuid;
  i int; n int;
  shops jsonb := $j$[
   {"slug":"demo-cbe-sri-valli","name":"Sri Valli Jewellers","legal":"Sri Valli Jewellers (Demo)","gstin":"33AAKFS1001A1Z4","city":"Coimbatore","k":"1","partner":true,
    "branches":[{"code":"CBE","name":"RS Puram, Coimbatore"},{"code":"CBEGP","name":"Gandhipuram, Coimbatore"}],
    "owner":"Senthil Kumar R","staff":[["Lakshmi Priya S","manager"],["Karthik M","salesperson"],["Revathi K","cashier"]]},
   {"slug":"demo-chn-kanchi-thangam","name":"Kanchi Thangam Maaligai","legal":"Kanchi Thangam Maaligai Pvt Ltd (Demo)","gstin":"33AAKFK1002B1Z9","city":"Chennai","k":"2","partner":false,
    "branches":[{"code":"TNGR","name":"T. Nagar, Chennai"},{"code":"MYLP","name":"Mylapore, Chennai"}],
    "owner":"Ramanathan V","staff":[["Deepa R","manager"],["Arun Prakash","salesperson"],["Saranya B","cashier"]]},
   {"slug":"demo-mdu-meenakshi-gold","name":"Meenakshi Gold House","legal":"Meenakshi Gold House (Demo)","gstin":"33AAKFM1003C1Z4","city":"Madurai","k":"3","partner":false,
    "branches":[{"code":"MDU","name":"South Masi Street, Madurai"}],
    "owner":"Muthupandi S","staff":[["Selvi M","salesperson"],["Ganesan P","cashier"]]},
   {"slug":"demo-tpr-kongu-jewel","name":"Kongu Jewel Palace","legal":"Kongu Jewel Palace (Demo)","gstin":"33AAKFK1004D1Z3","city":"Tiruppur","k":"4","partner":true,
    "branches":[{"code":"TPR","name":"Kumaran Road, Tiruppur"}],
    "owner":"Palanisamy K","staff":[["Kavitha P","manager"],["Dinesh Kumar","salesperson"],["Nithya S","cashier"]]},
   {"slug":"demo-slm-shevaroy","name":"Shevaroy Jewellers","legal":"Shevaroy Jewellers (Demo)","gstin":"33AAKFS1005E1ZS","city":"Salem","k":"5","partner":false,
    "branches":[{"code":"SLM","name":"Cherry Road, Salem"},{"code":"ATR","name":"Attur"}],
    "owner":"Elangovan T","staff":[["Malathi E","manager"],["Vignesh R","salesperson"]]}
  ]$j$;
  -- purity: code, metal, fineness, huid, sale rate/g, old-metal rate/g (demo values)
  purities jsonb := '[["24K","GOLD",999,true,12950,12690],["22K","GOLD",916,true,11870,11630],
                      ["18K","GOLD",750,true,9710,9520],["925","SILVER",925,false,165,150]]';
  items jsonb := '[["RING","Gold Ring","22K","tag","per_gram",450,[["LADIES","Ladies Ring"],["GENTS","Gents Ring"]]],
                   ["CHAIN","Gold Chain","22K","tag","percent",12,[["ROPE","Rope Chain"],["BOX","Box Chain"]]],
                   ["BANGLE","Gold Bangle","22K","tag","per_gram",380,[["PLAIN","Plain Bangle"],["KADA","Kada"]]],
                   ["STUD18","18K Studs","18K","tag","flat",1500,[["STUD","Ear Stud"]]],
                   ["COIN24","24K Gold Coin","24K","non_tag","flat",250,[["1G","1 g coin"],["8G","8 g coin"]]],
                   ["ANKLET","Silver Anklet (Kolusu)","925","tag","per_gram",25,[["KOLUSU","Kolusu"]]]]';
  custs jsonb := '[["Priya Ramesh","VIP"],["Murugan S","Regular"],["Anitha Kumar","Regular"],["Sundar Rajan","VIP"],["Gayathri N","Regular"]]';
  vends jsonb := '[["V-SUP","Kovai Bullion Suppliers (Demo)",["supplier"],"33AAKCS2001G1ZW"],
                   ["V-SMITH","Thangam Smith Works (Demo)",["smith","repair_vendor"],"33AAKCT2002H1ZS"],
                   ["V-REF","Cauvery Refinery (Demo)",["refiner"],"33AAKCR2003J1ZO"]]';
BEGIN
  -- ---------- demo partner (reseller) + one partner_admin login ----------
  SELECT id INTO v_partner FROM platform.partner WHERE slug = 'demo-partner-kovai';
  IF v_partner IS NULL THEN
    INSERT INTO platform.partner(slug, legal_name, gstin) VALUES ('demo-partner-kovai','Kovai Demo Resellers LLP (Demo)','33AAKFD1006F1Z4')
    RETURNING id INTO v_partner;
  END IF;
  PERFORM set_config('app.partner_id', v_partner::text, true);   -- partner_isolation policy on partner_user
  INSERT INTO platform.partner_user(partner_id, name, email, password_hash, role)
  VALUES (v_partner, 'Demo Partner Admin', 'partner.admin@demo.invalid', h, 'partner_admin')
  ON CONFLICT (partner_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash;
  PERFORM set_config('app.partner_id', '', true);

  FOR s IN SELECT * FROM jsonb_array_elements(shops) LOOP
    PERFORM set_config('app.tenant_id', '', true);
    SELECT id INTO t FROM platform.tenant WHERE slug = s->>'slug';
    IF t IS NULL THEN
      t := platform.provision_tenant(s->>'slug', s->>'name', CASE WHEN (s->>'partner')::boolean THEN v_partner END,
             s->>'legal', s->>'gstin', NULL, '33', s->'branches'->0->>'code', s->'branches'->0->>'name',
             s->>'owner', '900000' || (s->>'k') || '001', 'demo.' || split_part(s->>'slug','-',2) || '.owner', h, 'en', 'shared');
    END IF;
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE platform.tenant SET status = 'active' WHERE id = t AND status = 'trial';
    SELECT id INTO comp FROM platform.company WHERE tenant_id = t ORDER BY id LIMIT 1;
    UPDATE platform.company SET address = address || jsonb_build_object('demo', true, 'city', s->>'city', 'state', 'Tamil Nadu')
     WHERE tenant_id = t AND NOT (address ? 'demo');
    SELECT id INTO br1 FROM platform.branch WHERE tenant_id = t AND code = s->'branches'->0->>'code';

    -- extra branch(es)
    FOR b IN SELECT * FROM jsonb_array_elements(s->'branches') OFFSET 1 LOOP
      INSERT INTO platform.branch(tenant_id, company_id, code, name, bill_series_prefix, state_code)
      SELECT t, comp, b->>'code', b->>'name', b->>'code', '33'
      WHERE NOT EXISTS (SELECT 1 FROM platform.branch WHERE tenant_id = t AND code = b->>'code');
    END LOOP;

    -- staff logins with preset roles (owner came from provision_tenant)
    i := 1;
    FOR u IN SELECT * FROM jsonb_array_elements(s->'staff') LOOP
      i := i + 1;
      INSERT INTO platform.app_user(tenant_id, name, phone, username, password_hash, default_branch_id)
      SELECT t, u->>0, '900000' || (s->>'k') || lpad(i::text, 3, '0'),
             'demo.' || split_part(s->>'slug','-',2) || '.' || (u->>1), h, br1
      WHERE NOT EXISTS (SELECT 1 FROM platform.app_user WHERE tenant_id = t
                        AND username = 'demo.' || split_part(s->>'slug','-',2) || '.' || (u->>1));
      SELECT id INTO uid FROM platform.app_user WHERE tenant_id = t AND username = 'demo.' || split_part(s->>'slug','-',2) || '.' || (u->>1);
      INSERT INTO platform.user_role(tenant_id, user_id, role_id)
      SELECT t, uid, r.id FROM platform.role r WHERE r.tenant_id = t AND r.system_role_code = u->>1
        AND NOT EXISTS (SELECT 1 FROM platform.user_role ur WHERE ur.tenant_id = t AND ur.user_id = uid AND ur.role_id = r.id);
    END LOOP;
    UPDATE platform.app_user SET password_hash = h WHERE tenant_id = t AND username LIKE 'demo.%' AND password_hash IS DISTINCT FROM h;

    -- metals / purities
    INSERT INTO masters.metal(tenant_id, code, name, default_hsn) VALUES (t,'GOLD','Gold','7113'), (t,'SILVER','Silver','7113')
    ON CONFLICT (tenant_id, code) DO NOTHING;
    SELECT id INTO m_gold FROM masters.metal WHERE tenant_id = t AND code = 'GOLD';
    SELECT id INTO m_silver FROM masters.metal WHERE tenant_id = t AND code = 'SILVER';
    FOR x IN SELECT * FROM jsonb_array_elements(purities) LOOP
      INSERT INTO masters.purity(tenant_id, metal_id, code, fineness, huid_required, header_visible)
      VALUES (t, CASE x->>1 WHEN 'GOLD' THEN m_gold ELSE m_silver END, x->>0, (x->>2)::numeric, (x->>3)::boolean, x->>0 IN ('22K','925'))
      ON CONFLICT (tenant_id, metal_id, code) DO NOTHING;
      SELECT id INTO pur FROM masters.purity WHERE tenant_id = t AND code = x->>0;
      -- today's rates (tenant-wide)
      INSERT INTO rates.metal_rate(tenant_id, purity_id, kind, rate_date, rate_per_g, source)
      SELECT t, pur, k.kind, today, k.rate, 'manual'
      FROM (VALUES ('sale', (x->>4)::numeric), ('old_metal', (x->>5)::numeric)) k(kind, rate)
      WHERE NOT EXISTS (SELECT 1 FROM rates.metal_rate r WHERE r.tenant_id = t AND r.purity_id = pur AND r.kind = k.kind AND r.rate_date = today);
    END LOOP;

    -- GST config (tax rules: platform defaults from 045 are inherited)
    INSERT INTO masters.gst_config(tenant_id, effective_from)
    SELECT t, DATE '2017-07-01' WHERE NOT EXISTS (SELECT 1 FROM masters.gst_config WHERE tenant_id = t);

    -- counters per branch
    FOR br IN SELECT id FROM platform.branch WHERE tenant_id = t LOOP
      INSERT INTO masters.counter(tenant_id, branch_id, code, name)
      VALUES (t, br, 'GOLD1', 'Gold Counter 1'), (t, br, 'GOLD2', 'Gold Counter 2'), (t, br, 'SILVER', 'Silver Counter')
      ON CONFLICT (tenant_id, branch_id, code) DO NOTHING;
    END LOOP;

    -- items + sub-items
    FOR x IN SELECT * FROM jsonb_array_elements(items) LOOP
      SELECT id INTO cnt FROM masters.counter WHERE tenant_id = t AND branch_id = br1
        AND code = CASE WHEN x->>2 = '925' THEN 'SILVER' ELSE 'GOLD1' END;
      INSERT INTO masters.item(tenant_id, metal_id, purity_id, code, name, hsn, stock_type, mc_type, mc_value, wastage_type, wastage_value,
                               huid_charge, default_counter_id)
      SELECT t, p.metal_id, p.id, x->>0, x->>1, '7113', x->>3, x->>4, (x->>5)::numeric,
             CASE WHEN x->>3 = 'non_tag' THEN 'none' ELSE 'percent' END, CASE WHEN x->>3 = 'non_tag' THEN 0 ELSE 8 END,
             CASE WHEN p.huid_required AND x->>3 = 'tag' THEN 45 ELSE 0 END, cnt
      FROM masters.purity p WHERE p.tenant_id = t AND p.code = x->>2
      ON CONFLICT (tenant_id, code) DO NOTHING;
      SELECT id INTO it FROM masters.item WHERE tenant_id = t AND code = x->>0;
      INSERT INTO masters.sub_item(tenant_id, item_id, code, name)
      SELECT t, it, si->>0, si->>1 FROM jsonb_array_elements(x->6) si
      ON CONFLICT (tenant_id, item_id, code) DO NOTHING;
    END LOOP;

    -- customer groups, customers (fake phones, no PAN/Aadhaar), vendors
    INSERT INTO masters.customer_group(tenant_id, name) VALUES (t,'Regular'), (t,'VIP') ON CONFLICT (tenant_id, name) DO NOTHING;
    n := 0;
    FOR x IN SELECT * FROM jsonb_array_elements(custs) LOOP
      n := n + 1;
      SELECT id INTO grp FROM masters.customer_group WHERE tenant_id = t AND name = x->>1;
      INSERT INTO masters.customer(tenant_id, name, phone, state_code, address, group_id, home_branch_id, consent_at)
      SELECT t, x->>0, '900000' || (s->>'k') || lpad((100 + n)::text, 3, '0'), '33',
             jsonb_build_object('city', s->>'city', 'state', 'Tamil Nadu', 'demo', true), grp, br1, now()
      WHERE NOT EXISTS (SELECT 1 FROM masters.customer WHERE tenant_id = t AND phone = '900000' || (s->>'k') || lpad((100 + n)::text, 3, '0'));
    END LOOP;
    n := 0;
    FOR x IN SELECT * FROM jsonb_array_elements(vends) LOOP
      n := n + 1;
      INSERT INTO masters.vendor(tenant_id, code, name, kinds, gstin, state_code, contacts)
      VALUES (t, x->>0, x->>1, ARRAY(SELECT jsonb_array_elements_text(x->2)), x->>3, '33',
              jsonb_build_array(jsonb_build_object('name', 'Demo Contact', 'phone', '900000' || (s->>'k') || '9' || lpad(n::text, 2, '0'))))
      ON CONFLICT (tenant_id, code) DO NOTHING;
    END LOOP;

    -- onboarding: every billing-required step + branches + users completed
    UPDATE platform.onboarding_progress op
       SET status = 'completed', completed_at = now(), details = details || '{"demo":true}', updated_at = now()
     WHERE op.tenant_id = t AND op.status <> 'completed'
       AND (op.step IN (SELECT code FROM platform.onboarding_step WHERE required_for_billing)
            OR op.step IN ('branches','users_roles'));
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $seed$;

-- summary (no secrets)
SELECT 'demo shops: ' || count(*) FROM platform.tenant WHERE slug LIKE 'demo-%' AND slug NOT LIKE 'demo-deleted-%';
COMMIT;
