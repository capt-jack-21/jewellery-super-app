/**
 * Rates API layer (contract 0.7.4, backend fdc49b6). Screens import ONLY from here.
 */
import { ok } from '@/lib/api/fetcher';
import { getCurrentRates, getRateCard, getTodaysRateStatus, listRateHistory, publishRate, publishRateBatch } from '@/lib/api/backend/rates/rates';
import { listMetals, listPurities } from '@/lib/api/backend/masters/masters';
import { listBranches } from '@/lib/api/backend/tenant/tenant';
import type { MetalRate, MetalRateBatchInput, MetalRateInput } from '@/lib/api/backend/model';

export type RateKind = MetalRateInput['kind'];
export type { MetalRate };

/** 0.7.4 R1: one row of rates.v_todays_rate_status; without branch_id the shop summary also carries branches[]. */
export type { TodaysRateStatus, TodaysRateStatusRow, RateCard as RateCardData, MetalRateBatchInput } from '@/lib/api/backend/model';

export interface HistoryFilter { metal_id?: string; purity_id?: string; kind?: RateKind; branch_id?: string; from?: string; to?: string; cursor?: string; limit?: number }

/** Never send an empty branch_id (omitted → shop-wide). */
export const branchParam = (branchId?: string | null) => (branchId ? { branch_id: branchId } : undefined);

export const ratesKeys = {
  all: ['rates'] as const,
  current: (branchId?: string | null) => ['rates', 'current', branchId ?? null] as const,
  status: (branchId?: string | null) => ['rates', 'status', branchId ?? null] as const,
  history: (f: HistoryFilter) => ['rates', 'history', f] as const,
  card: (branchId?: string | null) => ['rates', 'card', branchId ?? null] as const,
  refs: ['rates', 'refs'] as const,
};

export const ratesApi = {
  /** In force now; with a branch the branch row beats the shop-wide row (server rule). */
  current: (branchId?: string | null) => ok(getCurrentRates(branchParam(branchId))),
  /** Shop-wide rows only (no branch_id) — used to show what a branch override replaces. */
  shopWide: () => ok(getCurrentRates()),
  /** Single insert (kept for one-offs). A same-day correction needs rates.edit → 403. */
  publish: (input: MetalRateInput) => ok(publishRate(input)),
  /** R4: all-or-nothing batch for one kind; the server derives the other purities. Idempotency-Key per attempt. */
  publishBatch: (body: MetalRateBatchInput, key: string) => ok(publishRateBatch(body, { 'Idempotency-Key': key })),
  /** R3: metal_id is a server filter; rows carry effective_to (exclusive) and derived_from_id / derived_rate_per_g. */
  history: (f: HistoryFilter) => ok(listRateHistory(f)),
  /** R1: with a branch → that branch's row (404 if unknown/inactive); without → shop summary + branches[]. */
  todaysStatus: (branchId?: string | null) => ok(getTodaysRateStatus(branchParam(branchId))),
  /** R2: server-composed rate card (doc_type rate_card). */
  rateCard: (branchId?: string | null) => ok(getRateCard(branchParam(branchId))),
  metals: () => ok(listMetals()),
  purities: () => ok(listPurities()),
  branches: () => ok(listBranches()),
};
