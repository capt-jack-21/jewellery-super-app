import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Check, Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText, OfflineBanner, PageHeader, EditGate } from '@/components/page';
import { EDIT_SETTINGS } from '@/lib/permissions';

import { PrintPreview } from '@/components/print-preview';
import { useT, useTk } from '@/i18n';
import { ApiError, ifMatch, ok } from '@/lib/api/fetcher';
import { useOnline } from '@/lib/offline/connectivity';
import { activatePrintTemplate, createPrintTemplate, getListPrintTemplatesQueryKey, listPrintTemplates } from '@/lib/api/backend/branding/branding';
import type { PrintDocType, PrintTemplate, PrintTemplateInputPaper } from '@/lib/api/backend/model';
import { PrintTemplateMetadata, tenantTemplateEditable } from './print-template-metadata';
import { RELEASE_PRINT_LOCALES, isPrintLanguage, isPrintLocale } from './print-language';
import { SEEDED_TEMPLATE_PINS } from '@/features/sales/templates';
import { numeralOptions, toContract, type PrintLocale, type PrintNumerals } from '@/lib/print/locales';

/** Preview components still speak the M0 doc/paper vocabulary; map from the contract enums. */
const KINDS = ['invoice', 'estimate', 'receipt', 'credit_note', 'order_receipt', 'tag_label'] as const satisfies readonly PrintDocType[];
const PAPERS = ['A4', 'A5', 'thermal_80mm', 'label'] as const satisfies readonly PrintTemplateInputPaper[];
const previewKind = (k: PrintDocType) => (k === 'invoice' ? 'tax_invoice' : k === 'estimate' || k === 'receipt' || k === 'credit_note' ? k : 'receipt');
const previewFormat = (p: PrintTemplateInputPaper) => (p === 'A5' ? 'a5' : p === 'A4' ? 'a4' : 'thermal_80');
interface PrintOpts { locale: PrintLocale; numerals: PrintNumerals }
interface PreviewDraft extends PrintOpts { doc_type: PrintDocType; paper: PrintTemplateInputPaper }
interface TagLabelDraft extends PrintOpts { paper: PrintTemplateInputPaper; body_key: string; show_logo: boolean; footer_text: string }
/** 0.9.6: tag_label templates (Inventory labels, client-drawn; only config.barcode_format is read) are exempt from the release-pin rule. */
export const TAG_LABEL: PrintDocType = 'tag_label';

/** Per-print language + numeral pickers, shared with the counter print dialog later. */
export function PrintOptionsFields({ value, onChange }: { value: PrintOpts; onChange: (v: PrintOpts) => void }) {
  const t = useT();
  const tk = useTk();
  return (
    <>
      <Field label={t('print.language')}>{(id) => (
        <Select id={id} data-testid="print-language" value={isPrintLocale(value.locale) ? value.locale : ''} onChange={(e) => {
          const locale = e.target.value; if (!isPrintLocale(locale)) return;
          onChange({ locale, numerals: numeralOptions(locale).includes(value.numerals) ? value.numerals : 'latn' });
        }}>
          <option value="" disabled>{t('print.language.pick')}</option>
          {RELEASE_PRINT_LOCALES.map((l) => <option key={l} value={l}>{tk(`print.locale.${l}`)}</option>)}
        </Select>)}</Field>
      {!isPrintLocale(value.locale) ? <p role="alert" data-testid="print-options-unsupported">{t('print.language.unsupported', { value: value.locale })}</p> : null}
      <Field label={t('print.numerals')}>{(id) => (
        <Select id={id} data-testid="print-numerals" value={value.numerals} onChange={(e) => onChange({ ...value, numerals: e.target.value as PrintNumerals })}>
          {numeralOptions(value.locale).map((n) => <option key={n} value={n}>{tk(`numerals.${n}`)}</option>)}
        </Select>)}</Field>
    </>
  );
}

/** Shop-visible rows the frontend can actually print: only the four bundled platform defaults (seeded UUID + version 1). */
export function isPlatformDefaultTemplate(r: Pick<PrintTemplate, 'id' | 'version'>) {
  return SEEDED_TEMPLATE_PINS.some((p) => p.id === r.id && p.version === r.version);
}
const SALES_KINDS: readonly PrintDocType[] = ['invoice', 'estimate', 'receipt', 'credit_note'];

/**
 * 0.9.5 printfix B-2 / contract 0.9.6: Sales prints only with the platform defaults (four 998 UUIDs, v1). Custom Sales template create /
 * activate / default selection stay hidden (the server answers 422 print_template_not_renderable). Rows show the server's read-only
 * `renderable`. tag_label is exempt and keeps its 0.9.5 create + activate path unchanged (Inventory QR/code128 labels).
 */
export function PrintTemplatesManager() {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const list = useQuery({ queryKey: getListPrintTemplatesQueryKey(), queryFn: () => ok(listPrintTemplates()) });
  const [tag, setTag] = useState<TagLabelDraft>({ paper: 'label', locale: 'ta-IN', numerals: 'latn', body_key: '', show_logo: true, footer_text: '' });
  const inval = () => { void qc.invalidateQueries({ queryKey: getListPrintTemplatesQueryKey() }); void qc.invalidateQueries({ queryKey: ['/v1/onboarding'] }); };
  const createTag = useMutation({
    mutationFn: () => {
      if (!isPrintLocale(tag.locale)) throw new ApiError(422, 'print_language_not_supported', 'Choose English or Tamil');
      const c = toContract(tag.locale, tag.numerals);
      return ok(createPrintTemplate({ doc_type: TAG_LABEL, paper: tag.paper, body_key: tag.body_key.trim(), print_language: tag.locale === 'ta-IN' ? 'ta' : 'en', numeral_system: c.numeral_system,
        config: { bilingual: c.bilingual, show_logo: tag.show_logo, footer_text: tag.footer_text } }));
    },
    onSuccess: inval,
  });
  // If-Match carries row_version (NOT the document `version`). Only tag_label rows are activatable this release.
  const activate = useMutation({ mutationFn: (r: PrintTemplate) => { if (r.doc_type !== TAG_LABEL || !tenantTemplateEditable(r)) throw new ApiError(403, 'forbidden', 'Read-only template'); if (!isPrintLanguage(r.print_language)) throw new ApiError(422, 'print_language_not_supported', 'Choose an English or Tamil template'); return ok(activatePrintTemplate(r.id, ifMatch(r.row_version))); }, onSettled: inval });
  const [f, setF] = useState<PreviewDraft>({ doc_type: 'invoice', paper: 'A4', locale: 'ta-IN', numerals: 'latn' });
  const numeralLabel = (r: PrintTemplate) => { const code: Record<string, string> = { latin: 'latn', tamil: 'taml', devanagari: 'deva', telugu: 'telu', kannada: 'knda', malayalam: 'mlym' }; const n = code[r.numeral_system ?? '']; return n ? tk(`numerals.${n}`) : r.numeral_system ?? '—'; };
  const columns: Array<ColumnDef<PrintTemplate>> = [
    { header: t('print.kind'), cell: (c) => tk(`print.doc.${c.row.original.doc_type}`) },
    { header: t('print.scope'), cell: (c) => <span>{tk(`print.scope.${c.row.original.scope}`)}{!tenantTemplateEditable(c.row.original) ? ` · ${t('common.readOnly')}` : ''}</span> },
    { header: t('print.metadata'), cell: (c) => <PrintTemplateMetadata id={c.row.original.id} version={c.row.original.version}/> },
    { header: t('print.version'), cell: (c) => <span className="tabular-nums">{`v${c.row.original.version}`}</span> },
    { header: t('print.format'), cell: (c) => tk(`print.paper.${c.row.original.paper ?? 'A4'}`) },
    { header: t('print.language'), cell: (c) => isPrintLanguage(c.row.original.print_language) ? tk(`print.locale.${c.row.original.print_language}-IN`) : t('print.language.unsupported', { value: c.row.original.print_language ?? '—' }) },
    { header: t('print.numerals'), cell: (c) => numeralLabel(c.row.original) },
    { header: t('common.status'), cell: (c) => <Badge variant={c.row.original.is_active ? 'success' : 'outline'}>{t(c.row.original.is_active ? 'print.active' : 'print.inactive')}</Badge> },
    { id: 'renderable', header: t('print.renderable'), cell: (c) => <span data-testid="print-renderable">{t(c.row.original.renderable ? 'print.renderable.yes' : 'print.renderable.no')}</span> },
    { id: 'printable', header: '', cell: (c) => isPlatformDefaultTemplate(c.row.original)
      ? <span data-testid="print-platform-default">{t('print.platformDefault')}</span>
      : c.row.original.is_active && !c.row.original.renderable && SALES_KINDS.includes(c.row.original.doc_type) ? <span role="alert" data-testid="print-not-renderable">{t('print.notRenderable')}</span> : null },
    { id: 'a', header: '', cell: (c) => (c.row.original.doc_type === TAG_LABEL && !c.row.original.is_active && tenantTemplateEditable(c.row.original)
      ? <Button size="sm" data-testid="tag-label-activate" disabled={!online || activate.isPending || !isPrintLanguage(c.row.original.print_language)} onClick={() => activate.mutate(c.row.original)}>{t('print.activate')}</Button> : null) },
  ];
  return (
    <div className="space-y-4">
      <p role="note" className="text-sm" data-testid="print-platform-only">{t('print.platformOnly')}</p>
      <DataTable columns={columns} data={list.data ?? []} caption={t('print.title')} />
      <ErrorText error={list.error} />
      <ErrorText error={activate.error} />
      <Card data-testid="tag-label-template">
        <CardHeader><CardTitle>{t('print.tagLabel.newDraft')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('print.tagLabel.note')}</p>
          <Field label={t('print.format')}>{(id) => (
            <Select id={id} value={tag.paper} onChange={(e) => setTag({ ...tag, paper: e.target.value as PrintTemplateInputPaper })}>
              {PAPERS.map((k) => <option key={k} value={k}>{tk(`print.paper.${k}`)}</option>)}
            </Select>)}</Field>
          <Field label={t('print.bodyKey')} hint={t('print.bodyKeyHint')}>{(id, d) => <Input id={id} aria-describedby={d} className="font-mono" maxLength={300} value={tag.body_key} onChange={(e) => setTag({ ...tag, body_key: e.target.value })} />}</Field>
          <PrintOptionsFields value={tag} onChange={(v) => setTag({ ...tag, ...v })} />
          <Check label={t('print.showLogo')} checked={!!tag.show_logo} onChange={(v) => setTag({ ...tag, show_logo: v })} />
          <Field label={t('print.footer')}>{(id) => <Input id={id} maxLength={300} value={tag.footer_text} onChange={(e) => setTag({ ...tag, footer_text: e.target.value })} />}</Field>
          <ErrorText error={createTag.error} />
          <Button data-testid="tag-label-save" disabled={!online || createTag.isPending || !tag.body_key.trim() || !isPrintLocale(tag.locale)} onClick={() => createTag.mutate()}>{t('print.saveDraft')}</Button>
        </CardContent>
      </Card>
      <div className="grid gap-4 xl:grid-cols-[22rem_1fr]">
        <Card>
          <CardHeader><CardTitle>{t('print.previewTitle')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Field label={t('print.kind')}>{(id) => (
              <Select id={id} value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value as PrintDocType })}>
                {KINDS.map((k) => <option key={k} value={k}>{tk(`print.doc.${k}`)}</option>)}
              </Select>)}</Field>
            <Field label={t('print.format')}>{(id) => (
              <Select id={id} value={f.paper} onChange={(e) => setF({ ...f, paper: e.target.value as PrintTemplateInputPaper })}>
                {PAPERS.map((k) => <option key={k} value={k}>{tk(`print.paper.${k}`)}</option>)}
              </Select>)}</Field>
            <PrintOptionsFields value={f} onChange={(v) => setF({ ...f, ...v })} />
          </CardContent>
        </Card>
        <div>
          <p className="mb-2 text-sm text-muted-foreground">{t('print.previewNote')}</p>
          {isPrintLocale(f.locale) ? <PrintPreview locale={f.locale} numerals={f.numerals} kind={previewKind(f.doc_type)} format={previewFormat(f.paper)} footer="" showLogo /> : <p role="alert">{t('print.language.unsupported', { value: f.locale })}</p>}
        </div>
      </div>
    </div>
  );
}

export function PrintTemplatesPage() {
  const t = useT();
  return <div><PageHeader title={t('print.title')} description={t('print.description')} /><OfflineBanner /><EditGate perm={EDIT_SETTINGS}><PrintTemplatesManager /></EditGate></div>;
}
