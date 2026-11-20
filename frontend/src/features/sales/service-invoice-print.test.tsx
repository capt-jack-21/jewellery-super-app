import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import { SalesPrintView } from './print';
import { invoice, pricedLine, printDoc, templateAsset } from './fixtures';
import type { Invoice, SalesPrintDocument } from '@/lib/api/backend/model';
afterEach(cleanup);

/** A repair bill: one SERVICE line (SAC 998892, GST 5%), no tag, no purity, zero goods columns (what Sales stores for a service line). */
function repairBill(): Invoice {
  const line = pricedLine({
    kind: 'service', tag_id: null, tag_no: null, item_id: null, sub_item_id: null, purity_id: null, purity_code: null, fineness: null, huid: null,
    description: 'Repair: clasp fixing', hsn: '998892', pieces: 1, gross_wt: '0.000', net_wt: '0.000', stone_wt: '0.000', chargeable_wt: '0.000',
    rate_id: null, rate_per_g: '0.00', metal_value: '0.00', mc_type: null, mc_value: null, mc_amount: '0.00', gross_value: '500.00', taxable_value: '500.00',
    tax_rate: '5', cgst: '12.50', sgst: '12.50', igst: '0.00', line_total: '525.00',
    tax_parts: [{ component: 'service', tax_rule_id: 'tr-svc', hsn_sac: '998892', composite_supply: false, taxable_value: '500.00', rate: '5', cgst_rate: '2.5', sgst_rate: '2.5', igst_rate: '0', cess_rate: '0', cgst: '12.50', sgst: '12.50', igst: '0.00', cess: '0.00' }],
  } as never);
  const base = invoice();
  return invoice({
    lines: [{ ...line, id: 'line-s1', credit_note_id: null }] as Invoice['lines'],
    tax_summary: [{ hsn_sac: '998892', rate: '5', taxable_value: '500.00', cgst: '12.50', sgst: '12.50', igst: '0.00', cess: '0.00' }] as Invoice['tax_summary'],
    totals: { ...base.totals, gross_value: '500.00', line_discount: '0.00', bill_discount: '0.00', taxable_value: '500.00', cgst: '12.50', sgst: '12.50', igst: '0.00', cess: '0.00', tax_total: '25.00', round_off: '0.00', invoice_total: '525.00', net_payable: '525.00', paid_amount: '525.00', balance_due: '0.00' },
    payment_status: 'paid',
  });
}

for (const paper of ['A4', 'A5', 'thermal_80mm'] as const) for (const language of ['en', 'ta'] as const)
  it(`repair bill (service line) prints on ${paper} ${language}: renders, shows the SAC, taxable value and total, never prints "null" or "undefined"`, () => {
    const snapshot = repairBill();
    const d = printDoc({ doc_type: 'invoice', document: snapshot, snapshot, paper, language, locale: `${language}-IN`, numerals: language === 'ta' ? 'tamil' : 'latin' } as Partial<SalesPrintDocument>);
    render(<I18nProvider initial="en-IN"><SalesPrintView doc={d} template={templateAsset(d)} /></I18nProvider>);
    const doc = screen.getByTestId('sales-doc');
    expect(doc.dataset.paper).toBe(paper);
    const text = doc.textContent ?? '';
    expect(text).toContain('998892');
    expect(text).toContain('Repair: clasp fixing');
    expect(text).not.toMatch(/\b(null|undefined|NaN)\b/);
  });
