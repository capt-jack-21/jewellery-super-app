/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import { sourceManifestPlugin } from './scripts/source-manifest';

/** Platform default brand name: used for index.html <title> (%VITE_BRAND_APP_NAME%) and as the runtime fallback. */
export const DEFAULT_BRAND_APP_NAME = 'Jewellery SaaS';

export default defineConfig(({ mode }) => {
  // Build-time default so the raw HTML title is never blank and %VITE_BRAND_APP_NAME% never leaks.
  // .env / real env values still win (only set when neither defines it).
  if (!process.env.VITE_BRAND_APP_NAME && !loadEnv(mode, process.cwd(), 'VITE_').VITE_BRAND_APP_NAME) process.env.VITE_BRAND_APP_NAME = DEFAULT_BRAND_APP_NAME;
  return {
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  plugins: [
    react(),
    sourceManifestPlugin(),
    VitePWA({
      registerType: 'prompt', // never auto-reload mid-bill
      injectRegister: false,
      // Manifest is served per host by the Branding service in production (/manifest.webmanifest).
      // This static one is the platform-default fallback for local dev/preview only. No colours here:
      // theme_color is injected at runtime from tokens.
      manifest: {
        name: 'Jewellery SaaS',
        short_name: 'Jewellery SaaS',
        start_url: '/',
        display: 'standalone',
        icons: [{ src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2,json}'],
        navigateFallbackDenylist: [/^\/api\//, /^\/mockServiceWorker\.js$/],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/v1/branding/theme'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'branding' },
          },
          // Online-only app: offline we only show the last-read data, read-only. GET only (workbox default);
          // writes are never cached or queued. Session + heartbeat endpoints always hit the network.
          {
            urlPattern: ({ url, request }) => request.method === 'GET' && url.pathname.startsWith('/api/v1/')
              && !/^\/api\/v1\/(auth\/|meta)/.test(url.pathname),
            handler: 'NetworkFirst',
            method: 'GET',
            options: { cacheName: 'api-read-cache', networkTimeoutSeconds: 4, expiration: { maxEntries: 300, maxAgeSeconds: 7 * 24 * 3600 } },
          },
        ],
      },
    }),
  ],
  // Local dev against a real API (devops/local/ui-real.sh): /api/* goes to the local backend. Unused with VITE_API_MOCKS=true.
  server: { proxy: { '/api': { target: process.env.DEV_API_URL ?? 'http://127.0.0.1:3000', changeOrigin: false } } },
  build: {
    rollupOptions: {
      output: {
        // Long-lived vendor chunks (cache across app releases); route code is split by lazy routes.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          if (id.includes('@tanstack')) return 'vendor-tanstack';
          if (/react-intl|@formatjs|intl-messageformat/.test(id)) return 'vendor-intl';
          if (/[\\/](zod|decimal\.js)[\\/]/.test(id)) return 'vendor-data';
          if (/lucide-react/.test(id)) return 'vendor-icons';
          if (/[\\/](msw|@mswjs|@bundled-es-modules|graphql|headers-polyfill|outvariant|strict-event-emitter|@open-draft)[\\/]/.test(id)) return 'dev-mocks';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
};
});
