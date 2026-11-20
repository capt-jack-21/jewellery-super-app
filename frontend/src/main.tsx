import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/query-client';
import { RouterProvider } from '@tanstack/react-router';
import './index.css';
import { applyBrand, loadBrand } from '@/lib/brand/loader';
import { BrandProvider } from '@/lib/brand/context';
import { I18nProvider } from '@/i18n';
import { ConnectivityProvider } from '@/lib/offline/connectivity';
import { router } from './router';


async function boot() {
  // MSW is dev-server only. `import.meta.env.DEV` is a literal `false` in every production build, so
  // the whole branch (and the msw import graph) is dropped even when VITE_API_MOCKS is unset or true.
  if (import.meta.env.DEV && import.meta.env.VITE_API_MOCKS === 'true') {
    const { worker } = await import('./mocks/browser');
    await worker.start({ onUnhandledRequest: 'bypass' });
  }
  const brand = await loadBrand();
  applyBrand(brand);
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <BrandProvider initial={brand}>
        <I18nProvider>
          <QueryClientProvider client={queryClient}><ConnectivityProvider><RouterProvider router={router} /></ConnectivityProvider></QueryClientProvider>
        </I18nProvider>
      </BrandProvider>
    </StrictMode>,
  );
}
void boot();
