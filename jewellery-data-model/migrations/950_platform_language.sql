-- 950_platform_language.sql — supported UI / print languages as a lookup; every language column references it.
-- Global catalogue (no tenant_id, no RLS), read-only for every app role (grants in 960). Adding a language = new
-- migration inserting a row. The existing format CHECKs stay (they reject garbage before the FK is consulted).
CREATE TABLE platform.language (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  name        text NOT NULL UNIQUE,
  native_name text NOT NULL
);
INSERT INTO platform.language(code, name, native_name) VALUES
  ('en', 'English',   'English'),
  ('ta', 'Tamil',     'தமிழ்'),
  ('hi', 'Hindi',     'हिन्दी'),
  ('te', 'Telugu',    'తెలుగు'),
  ('kn', 'Kannada',   'ಕನ್ನಡ'),
  ('ml', 'Malayalam', 'മലയാളം');

ALTER TABLE platform.tenant ADD CONSTRAINT tenant_default_language_fk
  FOREIGN KEY (default_language) REFERENCES platform.language(code);
ALTER TABLE platform.app_user ADD CONSTRAINT app_user_language_fk
  FOREIGN KEY (language) REFERENCES platform.language(code);           -- NULL = tenant default
ALTER TABLE branding.print_template ADD CONSTRAINT print_template_language_fk
  FOREIGN KEY (print_language) REFERENCES platform.language(code);
ALTER TABLE notifications.template ADD CONSTRAINT template_locale_fk
  FOREIGN KEY (locale) REFERENCES platform.language(code);             -- notification text language
