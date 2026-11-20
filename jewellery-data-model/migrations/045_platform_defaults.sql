-- 045_platform_defaults.sql — platform-seeded defaults every tenant inherits until it overrides them
-- (tenant rows in masters.tax_rule / masters.sales_policy). Values agreed with Adithya 20 Oct 2026; confirm with CA.
-- Runs as app_migrator (member of platform_writer => allowed by the platform-scope RLS write policies;
-- back-dated effective_from allowed only for app_migrator).
INSERT INTO masters.tax_rule(scope, code, description, component, metal_code, code_type, hsn_sac, rate, cgst_rate, sgst_rate, igst_rate,
                             composite_supply, principal_component, effective_from) VALUES
 ('platform','GOLD_JEWELLERY','Gold jewellery','metal','GOLD','HSN','7113',3,1.5,1.5,3,false,NULL,'2017-07-01'),
 ('platform','SILVER_JEWELLERY','Silver jewellery','metal','SILVER','HSN','7113',3,1.5,1.5,3,false,NULL,'2017-07-01'),
 ('platform','MAKING_COMPOSITE','Making charges as part of composite supply (taxed with metal, 3%)','making',NULL,'HSN','7113',3,1.5,1.5,3,true,'metal','2017-07-01'),
 ('platform','REPAIR_SERVICE','Repair / job service','service',NULL,'SAC','998892',5,2.5,2.5,5,false,NULL,'2017-07-01');

INSERT INTO masters.sales_policy(scope, making_gst_treatment, old_gold_valuation_basis, old_gold_excess_handling,
                                 credit_note_rounding, return_settlement_default, return_window_days, effective_from)
VALUES ('platform', 'composite', 'stated_purity', 'separate_purchase', 'follow_invoice', 'store_credit', 15, '2017-07-01');

-- P11-P13, N14, INV-5: platform setting defaults (tenant-overridable in platform.setting)
INSERT INTO platform.setting_default(key, value, value_type, description) VALUES
 ('auth.session_timeout_minutes', '30', 'integer', 'P11 auto logout after this many idle minutes'),
 ('auth.otp_login_enabled', 'false', 'boolean', 'P9 allow OTP login'),
 ('auth.otp_channel', '"sms"', 'text', 'P9 OTP channel: sms | whatsapp'),
 ('invoice.rounding', '"nearest_rupee"', 'text', 'P12 bill total rounding: none | nearest_rupee'),
 ('sales.pan_required_above', '200000.00', 'number', 'N14 PAN mandatory when bill value exceeds this (INR)'),
 ('alerts.cancellation.alert_every', 'true', 'boolean', 'INV-5 alert owner on every cancellation'),
 ('alerts.cancellation.escalate_per_branch_per_day', '5', 'integer', 'INV-5 escalate when cancellations per branch per day exceed this');
