import { describe, it, expect } from 'vitest';
import { RELEASE_PRINT_PINS, RELEASE_RENDERABLE_BODY_KEYS, isReleaseRenderablePin, releasePinFor } from './print-pins';

describe('B-2 release print pins', () => {
  it('lists exactly the four 998 platform v1 handlebars pins, one per Sales template doc_type', () => {
    expect(RELEASE_PRINT_PINS.map((p) => [p.doc_type, p.version, p.engine, p.body_key])).toEqual([
      ['invoice', 1, 'handlebars', 'tpl/platform/invoice.hbs'], ['estimate', 1, 'handlebars', 'tpl/platform/estimate.hbs'],
      ['credit_note', 1, 'handlebars', 'tpl/platform/credit_note.hbs'], ['receipt', 1, 'handlebars', 'tpl/platform/receipt.hbs']]);
    expect(new Set(RELEASE_PRINT_PINS.map((p) => p.template_id)).size).toBe(4);
    expect(RELEASE_RENDERABLE_BODY_KEYS).toHaveLength(4);
    expect(Object.isFrozen(RELEASE_PRINT_PINS)).toBe(true);
  });
  it('membership is exact (id, version, doc_type): a wrong version, doc_type or uuid is not renderable', () => {
    const inv = releasePinFor('invoice')!;
    expect(isReleaseRenderablePin('invoice', inv.template_id, 1)).toBe(true);
    expect(isReleaseRenderablePin('invoice', inv.template_id, 2)).toBe(false);
    expect(isReleaseRenderablePin('estimate', inv.template_id, 1)).toBe(false);
    expect(isReleaseRenderablePin('invoice', '00000000-0000-4000-8000-000000000001', 1)).toBe(false);
    expect(isReleaseRenderablePin('invoice', null, null)).toBe(false);
    expect(releasePinFor('tag_label')).toBeUndefined();
  });
});
