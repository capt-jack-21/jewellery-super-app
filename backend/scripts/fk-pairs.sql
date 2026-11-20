-- FK column pairs in key order, for scripts/fix-drizzle.py (drizzle-kit sorts local and foreign columns separately).
SELECT n.nspname, c.relname, k.conname,
  (SELECT string_agg(a.attname, ',' ORDER BY u.ord) FROM unnest(k.conkey, k.confkey) WITH ORDINALITY u(l, f, ord) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.l),
  fn.nspname, fc.relname,
  (SELECT string_agg(a.attname, ',' ORDER BY u.ord) FROM unnest(k.conkey, k.confkey) WITH ORDINALITY u(l, f, ord) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.f)
FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_class fc ON fc.oid = k.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
WHERE k.contype = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2, 3;
