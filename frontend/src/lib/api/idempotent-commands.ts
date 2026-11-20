/** Obligatory keys on direct settings/import commands, shared by their UI and boundary tests. */
import { commitImport } from './backend/import/import';
import { replaceGstConfig, replaceTaxRule } from './backend/settings/settings';
import { ok } from './fetcher';
export const commitImportWithKey = (id:string,key:string) => ok(commitImport(id,{'Idempotency-Key':key}));
export const replaceGstConfigWithKey = (id:string,body:Parameters<typeof replaceGstConfig>[1],key:string) => ok(replaceGstConfig(id,body,{'Idempotency-Key':key}));
export const replaceTaxRuleWithKey = (id:string,body:Parameters<typeof replaceTaxRule>[1],key:string) => ok(replaceTaxRule(id,body,{'Idempotency-Key':key}));
