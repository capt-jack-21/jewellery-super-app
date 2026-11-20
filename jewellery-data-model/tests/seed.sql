-- run as app_migrator
\set ON_ERROR_STOP 1
SET app.partner_id = '00000000-0000-0000-0000-0000000000a1';
INSERT INTO platform.partner(id, slug, legal_name) VALUES ('00000000-0000-0000-0000-0000000000a1','kovai-resell','Kovai Resellers LLP');
INSERT INTO platform.tenant(id, partner_id, slug, display_name) VALUES
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','sri-lakshmi','Sri Lakshmi Jewellers'),
 ('00000000-0000-0000-0000-000000000002', NULL, 'other-shop','Other Shop');
-- branding at three levels
INSERT INTO branding.theme(scope, app_name, logo_key, favicon_key, colors, fonts)
VALUES ('platform','JewelOS','platform/logo.svg','platform/fav.ico','{"primary":"#000000","accent":"#111111","bg":"#ffffff"}','{"body":"Inter"}');
INSERT INTO branding.theme(scope, partner_id, app_name, colors)
VALUES ('partner','00000000-0000-0000-0000-0000000000a1','GoldDesk','{"primary":"#880000"}');
INSERT INTO branding.sender_config(scope, partner_id, whatsapp_number, sms_sender_id, email_from_address, sms_dlt_template_ids)
VALUES ('partner','00000000-0000-0000-0000-0000000000a1','+919800000000','GLDDSK','bills@golddesk.in','{"bill":"P-1","otp":"P-2"}');
-- PLATFORM print templates now come from 998 (fixed published UUIDv7s), never from test fixtures.
-- In upgrade mode this seed runs at 990; lookups run only after 998. Tenant overrides below are still fixtures.
RESET app.partner_id;
-- platform tax rules and sales_policy defaults come from migrations/045_platform_defaults.sql

-- ===== tenant 1 =====
SET app.tenant_id = '00000000-0000-0000-0000-000000000001';
INSERT INTO branding.theme(scope, tenant_id, logo_key, colors) VALUES ('tenant','00000000-0000-0000-0000-000000000001','tenant/t1/logo.svg','{"accent":"#d4af37"}');
INSERT INTO branding.sender_config(scope, tenant_id, email_from_address, sms_dlt_template_ids)
VALUES ('tenant','00000000-0000-0000-0000-000000000001','billing@srilakshmi.in','{"bill":"T-1"}');
INSERT INTO branding.custom_domain(hostname, tenant_id, status, verified_at) VALUES ('billing.srilakshmi.in','00000000-0000-0000-0000-000000000001','verified',now());
INSERT INTO platform.company(tenant_id, id, legal_name, gstin, state_code) VALUES
 (current_setting('app.tenant_id')::uuid, '00000000-0000-0000-0000-00000000c001','Sri Lakshmi Jewellers','33ABCDE1234F1Z5','33');
INSERT INTO platform.branch(tenant_id, id, company_id, code, name, bill_series_prefix, state_code) VALUES
 (current_setting('app.tenant_id')::uuid, '00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-00000000c001','CBE','Coimbatore','CBE','33');
INSERT INTO platform.app_user(tenant_id, id, name, phone) VALUES
 (current_setting('app.tenant_id')::uuid, '00000000-0000-0000-0000-000000000a01','Cashier One','9000000001'),
 (current_setting('app.tenant_id')::uuid, '00000000-0000-0000-0000-000000000a02','Sales No-Perm','9000000002');
INSERT INTO platform.role(tenant_id, id, name, system_role_code) VALUES (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-000000000e01','Cashier','cashier');
INSERT INTO platform.user_role(tenant_id, user_id, role_id) VALUES
 (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-000000000a01','00000000-0000-0000-0000-000000000e01');
INSERT INTO masters.metal(tenant_id, id, code, name, default_hsn) VALUES (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-0000000000e1','GOLD','Gold','7113');
INSERT INTO masters.purity(tenant_id, id, metal_id, code, fineness, huid_required) VALUES
 (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-000000000022','00000000-0000-0000-0000-0000000000e1','22K',916,true);
-- GST rules: platform defaults + a tenant override (values are seed data, not schema)
INSERT INTO masters.tax_rule(scope, tenant_id, code, component, metal_code, code_type, hsn_sac, rate, cgst_rate, sgst_rate, igst_rate,
                             composite_supply, principal_component, effective_from, effective_to) VALUES
 ('tenant', current_setting('app.tenant_id')::uuid, 'GOLD_JEWELLERY','metal','GOLD','HSN','7113',3,1.5,1.5,3,false,NULL,'2017-07-01',NULL),
 ('tenant', current_setting('app.tenant_id')::uuid, 'MAKING_COMPOSITE','making','GOLD','HSN','7113',3,1.5,1.5,3,true,'metal','2017-07-01',NULL);
INSERT INTO masters.gst_config(tenant_id, effective_from) VALUES (current_setting('app.tenant_id')::uuid, '2017-07-01');
INSERT INTO masters.item(tenant_id, id, metal_id, purity_id, code, name, hsn, stock_type, mc_type, mc_value) VALUES
 (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-000000000901','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000022','RING','Gold Ring','7113','tag','per_gram',500),
 (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-000000000902','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000022','COIN','Gold Coin (non-tag)','7113','non_tag','flat',100);
INSERT INTO rates.metal_rate(tenant_id, purity_id, kind, rate_date, effective_from, rate_per_g) VALUES
 (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-000000000022','sale',(now() AT TIME ZONE 'Asia/Kolkata')::date, now() - interval '1 minute', 7000),
 (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-000000000022','old_metal',(now() AT TIME ZONE 'Asia/Kolkata')::date, now() - interval '1 minute', 6800);
INSERT INTO hr.staff(tenant_id, id, code, name, branch_id, is_salesperson) VALUES   -- 0.9.0 bills need a salesperson (992)
 (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-0000000057a0','SP-SEED','Seed salesperson','00000000-0000-0000-0000-00000000b001',true);
INSERT INTO masters.customer(tenant_id, id, name, phone, state_code) VALUES
 (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-000000000d01','Priya','9876543210','33');
INSERT INTO inventory.tag(tenant_id, id, branch_id, tag_no, item_id, purity_id, huid, gross_wt, stone_wt, net_wt, mc_type, mc_value,
                          wastage_pct, min_wastage_pct, min_sale_value, huid_charge) VALUES
 (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-00000000b001','T0001',
  '00000000-0000-0000-0000-000000000901','00000000-0000-0000-0000-000000000022','AB12CD',10.000,0.500,9.500,'per_gram',500,8,6,50000,45),
 (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000b001','T0002',
  '00000000-0000-0000-0000-000000000901','00000000-0000-0000-0000-000000000022','ZX98YW',5.000,0,5.000,'percent',12,0,0,NULL,45);
INSERT INTO inventory.tag_stone(tenant_id, tag_id, stone_id, pieces, weight, rate_type, rate, amount) VALUES
 (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-00000000f001',NULL,3,2.5,'per_ct',2000,5000);
INSERT INTO branding.print_template(scope, tenant_id, doc_type, version, body_key, is_active) VALUES
 ('tenant', current_setting('app.tenant_id')::uuid,'invoice',1,'tpl/t1/invoice-v1.hbs',true),
 ('tenant', current_setting('app.tenant_id')::uuid,'invoice',2,'tpl/t1/invoice-v2.hbs',false);

-- ===== tenant 2 =====
SET app.tenant_id = '00000000-0000-0000-0000-000000000002';
INSERT INTO platform.company(tenant_id, id, legal_name, state_code) VALUES (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-00000000c002','Other','29');
INSERT INTO platform.branch(tenant_id, id, company_id, code, name, bill_series_prefix, state_code) VALUES
 (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-00000000b002','00000000-0000-0000-0000-00000000c002','BLR','Bengaluru','BLR','29');
INSERT INTO masters.metal(tenant_id, id, code, name, default_hsn) VALUES (current_setting('app.tenant_id')::uuid,'00000000-0000-0000-0000-0000000000e2','GOLD','Gold','7113');

-- SaaS billing for tenant 1 (partner-visible) and tenant 2 (direct)
INSERT INTO billing.plan(code, name, modules, price_monthly, price_yearly) VALUES ('standard','Standard','{sales,inventory}', 1500, 15000);
SET app.tenant_id = '00000000-0000-0000-0000-000000000001';
INSERT INTO billing.subscription(tenant_id, plan_code, status, billing_cycle, current_period_start, current_period_end)
VALUES ('00000000-0000-0000-0000-000000000001','standard','active','monthly','2026-10-01','2026-10-31');
SET app.tenant_id = '00000000-0000-0000-0000-000000000002';
INSERT INTO billing.subscription(tenant_id, plan_code, status, billing_cycle, current_period_start, current_period_end)
VALUES ('00000000-0000-0000-0000-000000000002','standard','trial','monthly','2026-10-01','2026-10-31');
RESET app.tenant_id;
INSERT INTO platform.platform_admin(email, name, password_hash) VALUES ('ops@jewelos.in','Ops','argon2id$dev');
