import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const COLOR_LITERAL = String.raw`/(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\()/`;

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'node_modules', 'public/mockServiceWorker.js', 'src/lib/api/backend/**', 'src/lib/api/pending/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.strict],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      'no-restricted-globals': ['error',
        { name: 'parseFloat', message: 'Use decimal strings + decimal.js (lib/format) for money and weight.' },
        { name: 'fetch', message: 'Use the generated API client (lib/api/fetcher is the only fetch).' }],
      'no-restricted-syntax': ['error',
        { selector: `Literal[value=${COLOR_LITERAL}]`, message: 'No colour literals: use design tokens.' },
        { selector: `TemplateElement[value.raw=${COLOR_LITERAL}]`, message: 'No colour literals: use design tokens.' },
        { selector: String.raw`JSXText[value=/[A-Za-z\u0B80-\u0BFF]/]`, message: 'No hard-coded UI text: use i18n messages.' },
        { selector: "CallExpression[callee.property.name='toFixed'][callee.object.type!='CallExpression']", message: 'Avoid raw toFixed on numbers; use lib/format.' }],
    },
  },
  // Token sources may contain colour literals. The fetcher is the single HTTP entry point.
  { files: ['src/design-tokens/**', 'src/**/*.test.{ts,tsx}'], rules: { 'no-restricted-syntax': 'off' } },
  { files: ['src/lib/api/fetcher.ts'], rules: { 'no-restricted-globals': 'off' } },
  { files: ['src/lib/format/**', 'src/mocks/**'], rules: { 'no-restricted-syntax': 'off' } },
  { files: ['*.config.{ts,js}', 'scripts/**'], languageOptions: { globals: globals.node } },
);
