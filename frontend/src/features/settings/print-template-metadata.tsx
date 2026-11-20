import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { ErrorText } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { ApiError, ok } from '@/lib/api/fetcher';
import { getPrintTemplate, getGetPrintTemplateQueryKey } from '@/lib/api/backend/branding/branding';
import type { PrintTemplate } from '@/lib/api/backend/model';
export const tenantTemplateEditable = (r: PrintTemplate) => r.scope === 'tenant' && r.read_only === false;
/** Informational only: never replaces the immutable bundled renderer or chooses an active version. */
export function PrintTemplateMetadata({ id, version }: { id: string | null; version?: number | null }) {
  const t=useT(),tk=useTk(); const [open,setOpen]=useState(false);
  const q=useQuery({queryKey:[...getGetPrintTemplateQueryKey(id ?? ''),version ?? null],enabled:open && !!id,retry:false,queryFn:async()=>{
    const r=await ok(getPrintTemplate(id as string));
    if(r.id!==id || (version!=null && r.version!==version)) throw new ApiError(422,'pinned_print_template_unavailable','Exact template metadata mismatch');
    return r;
  }});
  if(!id) return <span>{t('sales.print.legacyPin')}</span>;
  return <span className="inline-block print:hidden" data-testid="exact-template-metadata">
    <Button type="button" size="sm" variant="ghost" onClick={()=>setOpen(!open)}>{t('print.metadata')}</Button>
    {open ? <span className="block"><ErrorText error={q.error}/>{q.isFetching ? t('common.loading'):null}{q.data ? <span data-testid="exact-template-details" className="block">
      <span lang="en" className="font-mono">{`${q.data.id} · v${q.data.version} · ${q.data.body_key}`}</span>{' · '}{tk(`print.scope.${q.data.scope}`)}{' · '}{t(tenantTemplateEditable(q.data)?'print.tenantEditable':'common.readOnly')}
    </span>:null}</span>:null}
  </span>;
}
