import { createContext, useContext, useState, type ReactNode } from 'react';
import { applyBrand, type Brand } from './loader';

interface BrandCtx { brand: Brand; setBrand: (b: Brand) => void }
const Ctx = createContext<BrandCtx | null>(null);

export function BrandProvider({ initial, children }: { initial: Brand; children: ReactNode }) {
  const [brand, set] = useState(initial);
  const setBrand = (b: Brand) => { applyBrand(b); set(b); };
  return <Ctx.Provider value={{ brand, setBrand }}>{children}</Ctx.Provider>;
}
/** The only way components get brand text (app name, support contacts). */
export function useBrand(): BrandCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useBrand outside BrandProvider');
  return c;
}
