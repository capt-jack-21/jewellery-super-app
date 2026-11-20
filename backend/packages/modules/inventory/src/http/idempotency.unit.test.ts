import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { InventoryTagsController, InventoryStockController, InventoryTransfersController, InventoryStockChecksController,
  InventoryAdjustmentsController, InventoryLotsController } from './controllers';

// Real HTTP handler entry points, not a mocked key helper. These probes deliberately fail before any DB/service call.
const reply = { status: (_n: number) => {}, header: (_k: string, _v: string) => {} };
const id = '00000000-0000-4000-8000-000000000001';
const tags = new InventoryTagsController(), stock = new InventoryStockController(), transfers = new InventoryTransfersController();
const routes: [string, (req: never) => Promise<unknown>][] = [
  ['tags', r=>tags.create(r,{},reply)], ['tags/bulk', r=>tags.bulk(r,{},reply)], ['labels', r=>tags.labels(r,{},reply)],
  ['loose-stock/receipts', r=>stock.receipt(r,{},reply)], ['moves', r=>stock.move(r,{},reply)],
  ['transfers', r=>transfers.create(r,{},reply)], ['transfers/{id}/dispatch', r=>transfers.dispatch(r,id,{},reply)],
  ['transfers/{id}/receive', r=>transfers.receive(r,id,{},reply)], ['stock-checks', r=>new InventoryStockChecksController().start(r,{},reply)],
  ['adjustments', r=>new InventoryAdjustmentsController().request(r,{},reply)], ['lots', r=>new InventoryLotsController().create(r,{},reply)],
];
describe('QA IDEM-3 Inventory obligatory route guards',()=>{
  it.each(routes)('%s: missing/empty400, malformed present422, before body or If-Match',async(_path,run)=>{
    for(const [key,status,code] of [[undefined,400,'idempotency_key_required'],['',400,'idempotency_key_required'],['bad',422,'idempotency_key_invalid'],
      ['valid-key-00000001',422,'validation_failed']] as const) {
      let problem: {getStatus():number;getResponse():unknown}|undefined;
      try { await run({headers:key===undefined?{}:{'idempotency-key':key}} as never); }
      catch(e) { problem=e as typeof problem; }
      const [wantStatus,wantCode] = key==='valid-key-00000001' && _path.endsWith('/dispatch') ? [428,'precondition_required'] : [status,code];
      expect(problem).toBeDefined(); expect(problem!.getStatus()).toBe(wantStatus); expect(problem!.getResponse()).toMatchObject({code:wantCode});
    }
  });
});
