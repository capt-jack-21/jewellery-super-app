import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/messages/en-IN.json';
import { ApiError } from '@/lib/api/fetcher';
import { sessionQueryOptions } from '@/lib/session';
import { ChangePasswordPage, isWrongCurrent } from '@/features/auth/password';
import { isReprintRequired, LabelSheet, labelRun, parseIds, reprintReasonOk, TAG_LABEL_DOC_TYPE } from './labels';
import { NotReadyOr, StatusBadge } from './ui';
import { hasFieldCode, isFeatureOff, isNotReady, inventoryApi, inventoryKeys, labelsBody } from './api';
import { labelPrintedText, makingChargeText, placeText, tagStatusParam } from './stock';
import { checkCounts, createdAdjustmentIds, pageItems, reportRowStatus, Running, safeDateTime, startAndLoadCheck } from './scan-check';
import { transferPieceCount } from './transfers';
import { looseError } from './loose';
import { INV, INVENTORY_ROUTE_PERMS, routePermFor } from '@/lib/permissions';
import { FEATURE_INVENTORY_PERMS } from '@/features/flags';

type Reply = { status: number; body?: unknown };
let replies: Reply[] = [];
const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
beforeEach(() => {
  replies = []; calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body as string | undefined });
    const r = replies.shift() ?? { status: 404, body: { title: 'Not Found' } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': r.status >= 400 ? 'application/problem+json' : 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ui = (node: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(sessionQueryOptions.queryKey, { user: { id: 'u', name: 'Owner', version: 1 }, roles: [{ role: 'owner' }], permissions: [] } as never);
  return render(<QueryClientProvider client={qc}><I18nProvider initial="en-IN">{node}</I18nProvider></QueryClientProvider>);
};

describe('inventory API (contract 0.8.3; generic 404/501 guard kept)', () => {
  it('404/501 on an assumed path = not switched on yet; a real 404 code is not', () => {
    expect(isNotReady(new ApiError(404, undefined, 'Not Found'))).toBe(true);
    expect(isNotReady(new ApiError(501, 'not_implemented', 'x'))).toBe(true);
    expect(isNotReady(new ApiError(404, 'tag_not_found', 'x'))).toBe(false);
    expect(isNotReady(new ApiError(500, undefined, 'x'))).toBe(false);
  });
  it('shows the friendly note for an assumed endpoint that is not there yet', async () => {
    const err = await inventoryApi.tags({}).catch((e: unknown) => e);
    expect(calls[0]?.url).toBe('/api/v1/inventory/tags?limit=50');
    ui(<NotReadyOr error={err} />);
    expect(screen.getByTestId('inventory-not-ready').textContent).toBe(en['inventory.notReady']);
  });
  it('sends Idempotency-Key on creates and If-Match on changes', async () => {
    replies = [{ status: 201, body: { id: 'p1' } }, { status: 200, body: {} }, { status: 200, body: {} }];
    await inventoryApi.receiveLoose({ branch_id: 'b', item_id: 'i', purity_id: 'p', pieces: 1, gross_wt: '1.000', net_wt: '1.000' }, 'key-1');
    await inventoryApi.saveSettings({ version: 7, source: 'shop' }, { photos_enabled: false });
    await inventoryApi.saveSettings({ version: 0, source: 'default' }, { photos_enabled: false });
    expect(calls[0]?.headers.get('Idempotency-Key')).toBe('key-1');
    expect(calls[1]?.method).toBe('PATCH');
    expect(calls[1]?.headers.get('If-Match')).toBe('"7"');
    expect(calls[2]?.headers.get('If-Match')).toBeNull();
  });
  it('tag lookup uses the 0.8.0 tag-lookup path and encodes the code', async () => {
    replies = [{ status: 200, body: { id: 't', tag_no: 'A/1' } }, { status: 200, body: { id: 't' } }];
    await inventoryApi.lookup(' A/1 ', 'b1');
    expect(calls[0]?.url).toBe('/api/v1/inventory/tag-lookup/A%2F1?branch_id=b1');
    await inventoryApi.lookup('T000123');
    expect(calls[1]?.url).toBe('/api/v1/inventory/tag-lookup/T000123');
  });
  it('labels POST records the print; a feature-off 409 is told apart', async () => {
    replies = [{ status: 200, body: { doc_type: 'tag_label', template: {}, labels: [] } }];
    await inventoryApi.labels(['t1'], 'lbl-1', { copies: 2 });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.get('Idempotency-Key')).toBe('lbl-1');
    expect(calls[0]?.url).toBe('/api/v1/inventory/labels');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ tag_ids: ['t1'], copies: 2, reprint: false });
    expect(JSON.parse(calls[0]?.body ?? '{}')).not.toHaveProperty('reprint_reason');
    expect(isFeatureOff(new ApiError(409, 'feature_disabled', 'x'))).toBe(true);
    expect(isFeatureOff(new ApiError(409, 'version_conflict', 'x'))).toBe(false);
  });
});

describe('inventory headers (contract 0.8.2: If-Match on every decision)', () => {
  it('status change sends If-Match and a trimmed reason', async () => {
    replies = [{ status: 200, body: { id: 't1' } }];
    await inventoryApi.changeStatus({ id: 't1', version: 4 }, 'repair', '  clasp  ');
    expect(calls[0]?.url).toBe('/api/v1/inventory/tags/t1/status');
    expect(calls[0]?.headers.get('If-Match')).toBe('"4"');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ status: 'repair', reason: 'clasp' });
  });
  it('transfer approve / return / cancel send If-Match; dispatch and receive send If-Match AND Idempotency-Key', async () => {
    replies = Array.from({ length: 5 }, () => ({ status: 200, body: { id: 'tr' } }));
    const tr = { id: 'tr', version: 2 };
    await inventoryApi.approveTransfer(tr);
    await inventoryApi.dispatchTransfer(tr, 'd-1');
    await inventoryApi.receiveTransfer(tr, { line_ids: ['l1'] }, 'r-1');
    await inventoryApi.returnTransfer(tr, ' damaged ');
    await inventoryApi.cancelTransfer(tr);
    expect(calls.map((c) => c.headers.get('If-Match'))).toEqual(['"2"', '"2"', '"2"', '"2"', '"2"']);
    expect(calls.map((c) => c.headers.get('Idempotency-Key'))).toEqual([null, 'd-1', 'r-1', null, null]);
    expect(JSON.parse(calls[3]?.body ?? '{}')).toEqual({ reason: 'damaged' });
  });
  it('stock-check close / cancel send If-Match', async () => {
    replies = [{ status: 200, body: { id: 'c' } }, { status: 200, body: { id: 'c' } }];
    await inventoryApi.closeCheck({ id: 'c', version: 9 }, true);
    await inventoryApi.cancelCheck({ id: 'c', version: 9 });
    expect(calls[0]?.url).toBe('/api/v1/inventory/stock-checks/c/close');
    expect(calls.map((c) => c.headers.get('If-Match'))).toEqual(['"9"', '"9"']);
  });
});

describe('inventory API (contract 0.8.3: lots, summary, moves, draft edit, scans)', () => {
  const lot = { id: 'L1', version: 4 };
  it('lot create sends Idempotency-Key; lot edit and close send If-Match (0.8.4)', async () => {
    replies = [{ status: 201, body: { id: 'L1' } }, { status: 200, body: {} }, { status: 200, body: {} }];
    await inventoryApi.createLot({ branch_id: 'b', received_on: '2026-11-05', lines: [{ item_id: 'i', pieces: 2, gross_wt: '5.000', net_wt: '5.000' }] }, 'lot-key');
    await inventoryApi.updateLot(lot, { ref_invoice_no: 'B-1' });
    await inventoryApi.closeLot(lot, { remainder: 'to_loose' });
    expect(calls[0]?.url).toBe('/api/v1/inventory/lots');
    expect(calls[0]?.headers.get('Idempotency-Key')).toBe('lot-key');
    expect(calls[1]?.method).toBe('PATCH');
    expect(calls[1]?.headers.get('If-Match')).toBe('"4"');
    expect(calls[2]?.url).toBe('/api/v1/inventory/lots/L1/close');
    expect(JSON.parse(calls[2]?.body ?? '{}')).toEqual({ remainder: 'to_loose' });
    expect(calls[2]?.headers.get('If-Match')).toBe('"4"');
  });
  it('0.8.5 tag list: "Active" sends no status (server default hides terminal pieces); "Any status" names every status', async () => {
    replies = [{ status: 200, body: { items: [], next_cursor: null } }, { status: 200, body: { items: [], next_cursor: null } }, { status: 200, body: { items: [], next_cursor: null } }];
    await inventoryApi.tags({ status: tagStatusParam('active') });
    await inventoryApi.tags({ status: tagStatusParam('') });
    await inventoryApi.tags({ status: tagStatusParam('written_off') });
    expect(calls[0]?.url).not.toContain('status=');
    for (const s of ['in_stock', 'sold', 'melted', 'returned_to_vendor', 'written_off']) expect(decodeURIComponent(calls[1]?.url ?? '')).toContain(s);
    expect(decodeURIComponent(calls[2]?.url ?? '')).toContain('written_off');
    expect(decodeURIComponent(calls[2]?.url ?? '')).not.toContain('in_stock');
    expect(en['error.tag_written_off']).toBeTruthy();
  });
  it('report pages by cursor with a result filter (0.8.4)', async () => {
    replies = [{ status: 200, body: { items: [], next_cursor: null, counts: {} } }, { status: 200, body: { items: [], next_cursor: null } }];
    await inventoryApi.report({ id: 'C1' }, 'missing', 'cur-2');
    await inventoryApi.scans({ id: 'C1' }, 'cur-3');
    expect(calls[0]?.url).toContain('/api/v1/inventory/stock-checks/C1/report?');
    expect(calls[0]?.url).toContain('result=missing');
    expect(calls[0]?.url).toContain('cursor=cur-2');
    expect(calls[0]?.url).toContain('limit=200');
    expect(calls[1]?.url).toContain('cursor=cur-3');
  });
  it('draft transfer edit PATCHes with If-Match and trims remarks to null', async () => {
    replies = [{ status: 200, body: {} }];
    await inventoryApi.updateTransfer({ id: 'T1', version: 2 }, { remarks: '   ', lines: [{ tag_id: 't1' }] });
    expect(calls[0]?.url).toBe('/api/v1/inventory/transfers/T1');
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.headers.get('If-Match')).toBe('"2"');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ remarks: null, lines: [{ tag_id: 't1' }] });
  });
  it('summary, scans, photos and moves use the 0.8.3 paths', async () => {
    replies = [{ status: 200, body: {} }, { status: 200, body: { items: [] } }, { status: 200, body: [] }, { status: 200, body: { items: [] } }];
    await inventoryApi.summary('b1');
    await inventoryApi.scans({ id: 'C1' });
    await inventoryApi.photos('t1');
    await inventoryApi.moves({ branch_id: 'b1' });
    expect(calls[0]?.url).toBe('/api/v1/inventory/stock-summary?branch_id=b1&group_by=status&include_loose=true');
    expect(calls[1]?.url).toBe('/api/v1/inventory/stock-checks/C1/scans?limit=50');
    expect(calls[2]?.url).toBe('/api/v1/inventory/tags/t1/photos');
    expect(calls[3]?.url).toContain('/api/v1/inventory/moves?');
    expect(calls[3]?.url).toContain('branch_id=b1');
  });
  it('reads field codes, and has plain words for line_tagged / already_attached', () => {
    const e = new ApiError(422, 'validation_failed', 'x', undefined, [{ path: 'vendor_lot_ref', message: 'm', code: 'field_not_supported' }]);
    expect(hasFieldCode(e, 'vendor_lot_ref', 'field_not_supported')).toBe(true);
    expect(hasFieldCode(e, 'vendor_lot_ref', 'invalid')).toBe(false);
    expect(hasFieldCode(new ApiError(409, 'x', 'x'), 'vendor_lot_ref', 'field_not_supported')).toBe(false);
    expect(en['error.line_tagged']).toBeTruthy();
    expect(en['error.already_attached']).toBeTruthy();
    expect(en).not.toHaveProperty(['error.line_removal_unsupported']);
  });
});

describe('inventory permissions (contract 0.8.0 §3)', () => {
  it('uses the 16 new codes plus the two existing ones, and the flag is on', () => {
    const codes = Object.values(INV);
    expect(new Set(codes).size).toBe(18);
    expect(codes.every((c) => /^inventory\.([a-z_]+\.)?[a-z_]+$/.test(c))).toBe(true);
    expect(FEATURE_INVENTORY_PERMS).toBe(true);
    expect(routePermFor('/inventory/stock-check')).toBe(INV.stockCheckRun);
    expect(routePermFor('/inventory/valuation')).toBe(INV.valuationView);
    expect(routePermFor('/inventory/opening')).toBe('platform.import.run');
    expect(Object.keys(INVENTORY_ROUTE_PERMS)).toHaveLength(13);
    expect(INVENTORY_ROUTE_PERMS['/inventory/lots']).toBe(INV.stockView);
  });
  it('labels written_off (0.8.2) and shows a neutral badge for a status newer than this build', () => {
    ui(<><StatusBadge status="written_off" /><StatusBadge status="some_future_status" /></>);
    expect(screen.getByText(en['inventory.status.written_off'])).toBeTruthy();
    expect(screen.getByText('some_future_status')).toBeTruthy();
  });
});

describe('label print', () => {
  it('renders each label × copies with a drawn Code128 barcode and the duplicate mark', () => {
    ui(<LabelSheet size="small" labels={[{ tag_id: '1', tag_no: 'T000042', barcode_payload: 'T000042', item_name: 'Ring', purity_code: '22K', gross_wt: '4.200', net_wt: '4.000', huid: 'AB12CD', copies: 2, duplicate: true } as never]} />);
    expect(screen.getByTestId('label-sheet').getAttribute('data-doc-type')).toBe(TAG_LABEL_DOC_TYPE);
    expect(screen.getAllByTestId('tag-label')).toHaveLength(2);
    expect(screen.getAllByTestId('tag-label')[0]?.textContent).toContain('T000042');
    expect(screen.getAllByTestId('tag-label')[0]?.querySelector('svg rect')).toBeTruthy();
    expect(screen.getAllByText(en['inventory.labels.duplicate'])).toHaveLength(2);
  });
  it('QR templates draw a real QR (qrcode-generator), not the payload text, and keep Code128 off', () => {
    ui(<LabelSheet size="small" qr labels={[{ tag_id: '1', tag_no: 'T000042', barcode_payload: 'T000042', item_name: 'Ring', purity_code: '22K', gross_wt: '4.200', net_wt: '4.000', huid: null, copies: 1, duplicate: false } as never]} />);
    const qr = screen.getByTestId('qr');
    expect(qr.getAttribute('data-modules')).toBe('21');
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M0 0h1v1h-1z/);
    expect(screen.queryByTestId('barcode')).toBeNull();
    expect(screen.getByTestId('tag-label').querySelectorAll('p.font-mono')).toHaveLength(1);
  });
  it('parses ?ids= safely', () => {
    expect(parseIds('a, b,,a')).toEqual(['a', 'b']);
    expect(parseIds(undefined)).toEqual([]);
  });
});

describe('small screen helpers', () => {
  it('validates a loose receipt', () => {
    const m = { branch_id: 'b', item_id: 'i', purity_id: 'p', pcs: '0', gross: '10', stone: '' };
    expect(looseError(m)).toBeNull();
    expect(looseError({ ...m, branch_id: '' })).toBe('inventory.err.branch');
    expect(looseError({ ...m, gross: '' })).toBe('inventory.err.gross');
    expect(looseError({ ...m, stone: '11' })).toBe('inventory.err.stone');
  });
});

describe('change my password (POST /v1/auth/password)', () => {
  const fill = (cur: string, next: string, confirm = next) => {
    fireEvent.change(screen.getByLabelText(en['password.current']), { target: { value: cur } });
    fireEvent.change(screen.getByLabelText(en['password.new']), { target: { value: next } });
    fireEvent.change(screen.getByLabelText(en['password.confirm']), { target: { value: confirm } });
    fireEvent.click(screen.getByRole('button', { name: en['password.change.submit'] }));
  };
  it('shows a wrong current password inline (401 invalid_credentials is not a sign-out)', async () => {
    replies = [{ status: 401, body: { code: 'invalid_credentials', title: 'Unauthorized' } }];
    ui(<ChangePasswordPage />);
    fill('old-one-x', 'new-password-1');
    await waitFor(() => expect(screen.getByText(en['password.err.wrongCurrent'])).toBeTruthy());
    expect(calls[0]?.url).toBe('/api/v1/auth/password');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ current_password: 'old-one-x', new_password: 'new-password-1' });
    expect(isWrongCurrent(new ApiError(401, 'session_invalid', 'x'))).toBe(false);
  });
  it('blocks a mismatch client-side and confirms success', async () => {
    ui(<ChangePasswordPage />);
    fill('old-one-x', 'new-password-1', 'new-password-2');
    expect(screen.getByText(en['password.err.mismatch'])).toBeTruthy();
    expect(calls).toHaveLength(0);
    replies = [{ status: 204 }];
    fill('old-one-x', 'new-password-1');
    await waitFor(() => expect(screen.getByTestId('password-changed').textContent).toBe(en['password.change.done']));
  });
});

describe('stock check start on an empty shop (live fix, 5 Nov 2026 2:52 PM IST)', () => {
  it('reads missing counts / items / dates without throwing', () => {
    expect(checkCounts(undefined)).toEqual({ expected: 0, scanned: 0, matched: 0, missing: 0, extra: 0 });
    expect(checkCounts({ expected: 3, matched: null })).toEqual({ expected: 3, scanned: 0, matched: 0, missing: 0, extra: 0 });
    expect(pageItems([{ items: null }, undefined, { items: [1, 2] }])).toEqual([1, 2]);
    expect(pageItems(undefined)).toEqual([]);
    expect(safeDateTime(undefined)).toBe('—');
    expect(safeDateTime('not a date')).toBe('—');
  });
  it('POST 201 without counts → GET the check and use its counts', async () => {
    const counts = { expected: 0, scanned: 0, matched: 0, missing: 0, extra: 0 };
    replies = [{ status: 201, body: { id: 'C9', branch_id: 'b', status: 'open', started_at: '2026-11-05T09:00:00Z', version: 1 } }, { status: 200, body: { id: 'C9', branch_id: 'b', status: 'open', started_at: '2026-11-05T09:00:00Z', version: 1, counts: { ...counts, expected: 2 } } }];
    const c = await startAndLoadCheck({ branch_id: 'b' } as never, 'k');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('/api/v1/inventory/stock-checks');
    expect(calls[1]?.url).toBe('/api/v1/inventory/stock-checks/C9');
    expect(c.counts).toEqual({ ...counts, expected: 2 });
  });
  it('falls back to zero counts when the read-back fails, and refuses a 201 without an id', async () => {
    replies = [{ status: 201, body: { id: 'C9', branch_id: 'b', status: 'open', version: 1 } }];
    const c = await startAndLoadCheck({ branch_id: 'b' } as never, 'k');
    expect(c.counts).toEqual({ expected: 0, scanned: 0, matched: 0, missing: 0, extra: 0 });
    replies = [{ status: 201, body: {} }];
    await expect(startAndLoadCheck({ branch_id: 'b' } as never, 'k2')).rejects.toThrow();
  });
  it('the running screen renders with no counts and an empty piece set', async () => {
    replies = Array.from({ length: 20 }, () => ({ status: 200, body: { items: null, next_cursor: null } }));
    ui(<Running check={{ id: 'C9', branch_id: 'b', status: 'open', version: 1 } as never} onUpdate={() => undefined} onEnd={() => undefined} />);
    expect(screen.getByTestId('check-progress').textContent).toContain('0');
    expect(screen.getByTestId('check-empty')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('check-report')).toBeTruthy());
  });
  it('the stock search hint says design code, not item name', () => {
    expect(en['inventory.searchHint']).toMatch(/design code/i);
    expect(en['inventory.searchHint']).not.toMatch(/item name/i);
  });
});

describe('live fixes (9 Nov 2026): labels body, report refresh, making charge', () => {
  it('labels: reprint_reason only on a reprint with a reason', () => {
    expect(labelsBody(['a'], {})).toEqual({ tag_ids: ['a'], copies: 1, reprint: false });
    expect(labelsBody(['a'], { reprintReason: null })).not.toHaveProperty('reprint_reason');
    expect(labelsBody(['a'], { reprintReason: '  ' })).not.toHaveProperty('reprint_reason');
    expect(labelsBody(['a'], { reprint: false, reprintReason: 'smudged label' })).not.toHaveProperty('reprint_reason');
    expect(labelsBody(['a'], { reprint: true, reprintReason: ' smudged label ' })).toEqual({ tag_ids: ['a'], copies: 1, reprint: true, reprint_reason: 'smudged label' });
  });
  it('report refresh: the prefix key invalidates every tab of that check, not other checks', async () => {
    const qc = new QueryClient();
    for (const r of ['missing', 'extra', 'matched'] as const) qc.setQueryData(inventoryKeys.report('C1', r), { pages: [] });
    qc.setQueryData(inventoryKeys.report('C2', 'missing'), { pages: [] });
    await qc.invalidateQueries({ queryKey: inventoryKeys.report('C1') });
    expect(qc.getQueryState(inventoryKeys.report('C1', 'missing'))?.isInvalidated).toBe(false);
    await qc.invalidateQueries({ queryKey: inventoryKeys.reportAll('C1') });
    for (const r of ['missing', 'extra', 'matched'] as const) expect(qc.getQueryState(inventoryKeys.report('C1', r))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(inventoryKeys.report('C2', 'missing'))?.isInvalidated).toBe(false);
  });
  it('making charge reads plainly and never says undefined', () => {
    const msgs = en as Record<string, string>;
    const t = (k: string, p?: Record<string, string | number>) => Object.entries(p ?? {}).reduce((a, [x, v]) => a.split(`{${x}}`).join(String(v)), msgs[k] ?? k);
    expect(makingChargeText(undefined, undefined, t as never)).toBe('—');
    expect(makingChargeText(null, null, t as never)).toBe('—');
    expect(makingChargeText('per_gram', '350', t as never)).toBe('₹350.00 a gram');
    expect(makingChargeText('per_piece', '1500', t as never)).toBe('₹1,500.00 a piece');
    expect(makingChargeText('flat', '125000', t as never)).toBe('₹1,25,000.00 fixed');
    expect(makingChargeText('percent', '12', t as never)).toBe('12.00% of metal value');
    expect(makingChargeText('per_gram', undefined, t as never)).toBe('Per gram');
    expect(makingChargeText(undefined, '200', t as never)).toBe('₹200.00');
    for (const k of ['per_gram', 'per_piece', 'flat', 'percent']) expect(msgs[`inventory.mc.show.${k}`]).toContain('{amount}');
  });
});

describe('contract 0.8.7: labels reprint, tag fields', () => {
  it('opens the reprint reason for 422 reprint_required and (server gap) 409 already_printed only', () => {
    expect(isReprintRequired(new ApiError(422, 'reprint_required', 'x'))).toBe(true);
    expect(isReprintRequired(new ApiError(409, 'already_printed', 'x'))).toBe(true);
    expect(isReprintRequired(new ApiError(409, 'feature_disabled', 'x'))).toBe(false);
    expect(isReprintRequired(new ApiError(422, 'validation_failed', 'x'))).toBe(false);
    expect(isReprintRequired(new Error('x'))).toBe(false);
    expect(en['error.already_printed']).toBeTruthy();
  });
  it('reprint reason is 3–200 characters after trimming', () => {
    expect(reprintReasonOk('  ab ')).toBe(false);
    expect(reprintReasonOk(' torn ')).toBe(true);
    expect(reprintReasonOk('x'.repeat(200))).toBe(true);
    expect(reprintReasonOk('x'.repeat(201))).toBe(false);
    expect(reprintReasonOk(`  ${'x'.repeat(200)}  `)).toBe(true);
    expect(en['inventory.labels.reprintReasonHint']).toContain('{max}');
  });
  it('place shows the tray only when the piece has one', () => {
    const refs = { counterName: (id?: string | null) => `C:${id ?? ''}`, trayName: (id?: string | null) => `T:${id ?? ''}` };
    expect(placeText({ counter_id: 'c1', tray_id: 't1' }, refs)).toBe('C:c1 · T:t1');
    expect(placeText({ counter_id: 'c1', tray_id: null }, refs)).toBe('C:c1');
    expect(placeText({}, refs)).toBe('—');
  });
  it('making charge / wastage read the 0.8.7 string decimals', () => {
    const msgs = en as Record<string, string>;
    const t = (k: string, p?: Record<string, string | number>) => Object.entries(p ?? {}).reduce((a, [x, v]) => a.split(`{${x}}`).join(String(v)), msgs[k] ?? k);
    expect(makingChargeText('per_gram', '350.00', t as never)).toBe('₹350.00 a gram');
    expect(makingChargeText('percent', '8.500', t as never)).toBe('8.50% of metal value');
  });
});

describe('contract 0.8.8: label rows, close ids, report status, transfer lines', () => {
  const row = (x: Record<string, unknown>) => ({ tag_id: 't', tag_no: 'T1', barcode_payload: 'T1', gross_wt: '1.000', net_wt: '1.000', duplicate: false, ...x }) as never;
  it('repeats each label row by its own copies, else by the copies asked for', () => {
    expect(labelRun([{ copies: 3 }, { copies: 1 }], 2).length).toBe(4);
    expect(labelRun([{}, { copies: null }], 2).length).toBe(4);
    expect(labelRun([{ copies: 0 }], 0).length).toBe(1);
    expect(labelRun(undefined, 2)).toEqual([]);
  });
  it('the sheet draws copies per row and marks duplicates only', () => {
    ui(<LabelSheet size="small" fallbackCopies={2} labels={[row({ tag_id: 'a', tag_no: 'A1', copies: 3, duplicate: true }), row({ tag_id: 'b', tag_no: 'B1', duplicate: false })]} />);
    expect(screen.getAllByTestId('tag-label')).toHaveLength(5);
    expect(screen.getAllByTestId('label-duplicate')).toHaveLength(3);
    expect(screen.getAllByText('A1')).toHaveLength(3);
    expect(screen.getAllByText('B1')).toHaveLength(2);
  });
  it('close: created_adjustment_ids, with adjustment_ids as a fallback', () => {
    expect(createdAdjustmentIds({ created_adjustment_ids: ['a1', 'a2'] })).toEqual(['a1', 'a2']);
    expect(createdAdjustmentIds({ adjustment_ids: ['old'] })).toEqual(['old']);
    expect(createdAdjustmentIds({ created_adjustment_ids: [], adjustment_ids: ['old'] })).toEqual([]);
    expect(createdAdjustmentIds(null)).toEqual([]);
  });
  it('report rows: status, falling back to tag_status', () => {
    expect(reportRowStatus({ status: 'in_stock', tag_status: 'sold' })).toBe('in_stock');
    expect(reportRowStatus({ tag_status: 'sold' })).toBe('sold');
    expect(reportRowStatus({ status: null })).toBeNull();
    expect(reportRowStatus(undefined)).toBeNull();
  });
  it('transfer piece count from lines is null-safe', () => {
    expect(transferPieceCount({ lines: [{ pieces: 1 }, { pieces: 2 }, { pieces: 0 }, {}] })).toBe(4);
    expect(transferPieceCount({ lines: null })).toBe(0);
    expect(transferPieceCount({})).toBe(0);
  });
});

describe('contract 0.8.9: label print time on the piece', () => {
  const t = (k: string) => (en as Record<string, string>)[k] ?? k;
  it('shows the last print in en-IN IST, or "Not printed yet"', () => {
    expect(labelPrintedText(null, t as never)).toBe('Not printed yet');
    expect(labelPrintedText(undefined, t as never)).toBe('Not printed yet');
    expect(labelPrintedText('garbage', t as never)).toBe('Not printed yet');
    expect(labelPrintedText('2026-11-09T12:30:00Z', t as never)).toBe('09-11-2026 18:00 IST');
    expect(en['inventory.labelPrintedAt']).toBeTruthy();
  });
});
