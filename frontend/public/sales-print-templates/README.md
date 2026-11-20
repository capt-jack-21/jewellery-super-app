# Retired archive convention — no asset store or fetch

Sales templates are now immutable built-ins in src/features/sales/bundled-v1.json and versioned renderer files. There are NO JSON/Handlebars assets to publish under this URL and the frontend NEVER fetches template metadata or source. This historical directory is retained only because VPS source deletions are prohibited.

Exact payload template_id + template_version maps through bundled-pins.json to seeded body_key + version. Paper/language/numerals are envelope options, not separate keys. Unknown IDs/keys/versions fail closed. engine is informational, not interpreted. New shipped versions are added, never edited or removed; frozen hash registry tests protect existing versions.
