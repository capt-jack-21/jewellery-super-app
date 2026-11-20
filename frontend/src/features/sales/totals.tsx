import { useT } from '@/i18n';
import { formatINR, formatPercent, formatWeight } from '@/lib/format';
import type { BillComputation, PricedLine, PricedOldGold } from '@/lib/api/backend/model';
import { componentTotals, isPositive } from './logic';
import { Money, Row } from './ui';

type Computed = Pick<BillComputation, 'lines' | 'tax_summary' | 'totals' | 'gst_type' | 'old_metal' | 'zero_gst'>;

/**
 * Live totals (server figures only): component sums, discount, taxable value, GST heads for the bill's GST type, round-off,
 * old gold, then a big AMOUNT TO PAY with paid / balance due. `paidNow` = what the counter has typed in the payment rows.
 */
export function BillTotalsPanel({ c, paidNow, stale }: { c: Computed; paidNow?: string; stale?: boolean }) {
  const t = useT();
  const parts = componentTotals(c.lines);
  const tt = c.totals;
  const intra = c.gst_type === 'intra';
  return (
    <section aria-label={t('sales.totals.title')} data-testid="bill-totals" aria-busy={stale || undefined} className={stale ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
      <div className="space-y-0.5 text-sm">
        <Row label={t('sales.line.metal')}><Money v={parts.metal} /></Row>
        <Row label={t('sales.line.making')}><Money v={parts.making} /></Row>
        {isPositive(parts.stones) ? <Row label={t('sales.line.stones')}><Money v={parts.stones} /></Row> : null}
        {isPositive(parts.hallmark) ? <Row label={t('sales.line.hallmark')}><Money v={parts.hallmark} /></Row> : null}
        {isPositive(parts.discount) ? <Row label={t('sales.totals.discount')}><Money v={`-${parts.discount}`} /></Row> : null}
        <Row label={t('sales.totals.taxable')} strong testId="taxable"><Money v={tt.taxable_value} /></Row>
        {c.zero_gst ? <Row label={t('sales.totals.zeroGst')}><Money v="0.00" /></Row> : intra ? (
          <>
            <Row label={t('sales.gst.cgst')} testId="cgst"><Money v={tt.cgst} /></Row>
            <Row label={t('sales.gst.sgst')} testId="sgst"><Money v={tt.sgst} /></Row>
          </>
        ) : <Row label={t('sales.gst.igst')} testId="igst"><Money v={tt.igst} /></Row>}
        {isPositive(tt.cess) ? <Row label={t('sales.gst.cess')}><Money v={tt.cess} /></Row> : null}
        {tt.round_off && tt.round_off !== '0.00' ? <Row label={t('sales.totals.roundOff')}><Money v={tt.round_off} /></Row> : null}
        <Row label={t('sales.totals.billTotal')} strong testId="invoice-total"><Money v={tt.invoice_total} /></Row>
        {isPositive(tt.old_metal_value) ? <Row label={t('sales.totals.oldGold')} testId="old-gold-total"><Money v={`-${tt.old_metal_value}`} /></Row> : null}
        {isPositive(tt.old_gold_excess) ? <Row label={t('sales.totals.oldGoldExcess')} testId="old-gold-excess"><Money v={tt.old_gold_excess} /></Row> : null}
      </div>
      <div className="mt-3 rounded-lg bg-primary/10 p-3" data-testid="payable">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('sales.totals.payable')}</p>
        <Money v={tt.net_payable} big />
      </div>
      {paidNow != null ? (
        <div className="mt-2 space-y-0.5 text-sm">
          <Row label={t('sales.totals.paid')} testId="paid-now"><Money v={paidNow} /></Row>
        </div>
      ) : null}
    </section>
  );
}

/** GST breakup by HSN / SAC and rate (rounded line parts summed by the server; never re-rounded). */
export function GstBreakup({ c }: { c: Pick<BillComputation, 'tax_summary' | 'gst_type' | 'zero_gst'> }) {
  const t = useT();
  if (!c.tax_summary.length) return null;
  const intra = c.gst_type === 'intra';
  return (
    <table className="w-full text-sm [&_td]:px-1 [&_td]:whitespace-nowrap [&_th]:px-1 [&_th]:align-bottom" data-testid="gst-breakup">
      <caption className="mb-1 text-left font-semibold">{t('sales.gst.breakup')}<span className="block text-xs font-normal text-muted-foreground" data-testid="gst-rounding-note">{t('sales.gst.roundingNote')}</span></caption>
      <thead className="text-xs text-muted-foreground">
        <tr><th className="text-left">{t('sales.gst.hsn')}</th><th className="text-right">{t('sales.gst.rate')}</th><th className="text-right">{t('sales.totals.taxable')}</th>
          {intra ? <><th className="text-right">{t('sales.gst.cgst')}</th><th className="text-right">{t('sales.gst.sgst')}</th></> : <th className="text-right">{t('sales.gst.igst')}</th>}</tr>
      </thead>
      <tbody>
        {c.tax_summary.map((r) => (
          <tr key={`${r.hsn_sac}-${r.rate}`} className="border-t border-border">
            <td lang="en" className="font-mono">{r.hsn_sac}</td><td className="text-right tabular-nums">{formatPercent(r.rate)}</td>
            <td className="text-right tabular-nums">{formatINR(r.taxable_value)}</td>
            {intra ? <><td className="text-right tabular-nums">{formatINR(r.cgst)}</td><td className="text-right tabular-nums">{formatINR(r.sgst)}</td></> : <td className="text-right tabular-nums">{formatINR(r.igst)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One priced old-gold row; an overridden rate shows "Rate changed from ₹X" with the reason (0.9.1). */
export function OldGoldRow({ o }: { o: PricedOldGold }) {
  const t = useT();
  return (
    <div className="text-sm" data-testid="old-gold-row">
      <p className="flex justify-between gap-2"><span>{o.purity_code} · {formatWeight(o.net_wt)}{o.touch_pct ? ` · ${formatPercent(o.touch_pct)}` : ''}{o.description ? ` · ${o.description}` : ''}</span><Money v={`-${o.amount}`} /></p>
      <p className="text-xs text-muted-foreground">{t('sales.oldGold.rateLine', { rate: formatINR(o.rate_per_g) })}</p>
      {o.overridden ? <p className="rounded bg-warning/15 px-1 text-xs" data-testid="rate-changed">{t('sales.oldGold.rateChanged', { rate: formatINR(o.server_rate), reason: o.override_reason ?? '' })}</p> : null}
    </div>
  );
}

/** Priced lines of a bill or estimate (tag no., or the "Loose" chip for untagged pieces), then the old gold taken. */
export function PricedLinesTable({ lines, oldMetal, testId }: { lines: Array<PricedLine & { id?: string; credit_note_id?: string | null }>; oldMetal: PricedOldGold[]; testId?: string }) {
  const t = useT();
  return (
    <>
      <table className="w-full text-sm [&_td]:px-1 [&_th]:px-1" data-testid={testId}>
        <thead className="text-xs text-muted-foreground"><tr className="text-left"><th>{t('sales.line.tag')}</th><th>{t('sales.line.item')}</th><th className="text-right">{t('sales.line.netWt')}</th><th className="text-right">{t('sales.line.amount')}</th></tr></thead>
        <tbody>{lines.map((l) => (
          <tr key={l.id ?? l.line_no} className="border-t border-border"><td lang={l.tag_no ? 'en' : undefined} className="whitespace-nowrap py-1 font-mono">{l.tag_no ?? (l.kind === 'loose' ? <span className="rounded bg-muted px-1 font-sans text-xs">{t('sales.loose.badge')}</span> : '—')}</td>
            <td className="py-1">{l.description} · {l.purity_code}{l.credit_note_id ? <span className="ml-2 text-xs text-muted-foreground">{t('sales.return.returned')}</span> : null}</td>
            <td className="whitespace-nowrap py-1 text-right tabular-nums">{formatWeight(l.net_wt)}</td><td className="whitespace-nowrap py-1 text-right tabular-nums">{formatINR(l.line_total)}</td></tr>))}</tbody>
      </table>
      {oldMetal.length ? <div className="mt-3 space-y-2 border-t border-border pt-2">{oldMetal.map((o) => <OldGoldRow key={o.line_no} o={o} />)}</div> : null}
    </>
  );
}
