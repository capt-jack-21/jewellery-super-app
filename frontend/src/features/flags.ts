/**
 * Compile-time feature flags (not env-dependent: same value in every build).
 * FEATURE_RATE_END_DATE — optional end date (effective_to) on "change rate" / "close and start new" (contract 0.4.4 allows it;
 * deferred by product). While false the field is not rendered and effective_to is never sent on replace/create.
 */
export const FEATURE_RATE_END_DATE = false as boolean;
/**
 * FEATURE_INVENTORY_PERMS — enforce the inventory.* permission codes (contract 0.8.0, INVENTORY-CONTRACT-NOTES §3) on routes,
 * nav and write buttons. ON since 0.8.0 made the 16 codes definitive. Roles get them from data-model 987; until 987 is on an
 * environment, users without the codes (or '*') see "no access" for inventory screens there.
 */
export const FEATURE_INVENTORY_PERMS = true as boolean;
/**
 * FEATURE_SALES — show the Sales / billing screens (contract 0.9.0). The /v1/sales routes are contract-only (404) until the
 * backend module ships; every Sales screen then shows "Billing isn't switched on yet" instead of failing, and the nav is
 * also permission-gated (sales.invoice.view / issue / estimate.create). Flip to false to hide Sales completely.
 */
export const FEATURE_SALES = true as boolean;
