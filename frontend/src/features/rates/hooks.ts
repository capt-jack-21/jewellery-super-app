import { useQuery } from '@tanstack/react-query';
import { useSignedIn } from '@/lib/session';
import { useCurrentDevice } from '@/features/devices/devices';
import { ratesApi, ratesKeys } from './api';

export function useRateRefs() {
  const signedIn = useSignedIn();
  const metals = useQuery({ queryKey: [...ratesKeys.refs, 'metals'], queryFn: ratesApi.metals, enabled: signedIn });
  const purities = useQuery({ queryKey: [...ratesKeys.refs, 'purities'], queryFn: ratesApi.purities, enabled: signedIn });
  const branches = useQuery({ queryKey: [...ratesKeys.refs, 'branches'], queryFn: ratesApi.branches, enabled: signedIn });
  return { metals: metals.data ?? [], purities: purities.data ?? [], branches: (branches.data ?? []).filter((b) => b.is_active), isLoading: metals.isLoading || purities.isLoading };
}
export function useCurrentRates(branchId?: string | null) {
  const signedIn = useSignedIn();
  return useQuery({ queryKey: ratesKeys.current(branchId), queryFn: () => ratesApi.current(branchId), enabled: signedIn });
}
export function useTodaysStatus(branchId?: string | null) {
  const signedIn = useSignedIn();
  return useQuery({ queryKey: ratesKeys.status(branchId), queryFn: () => ratesApi.todaysStatus(branchId), enabled: signedIn });
}
export function useRateCard(branchId?: string | null) {
  const signedIn = useSignedIn();
  return useQuery({ queryKey: ratesKeys.card(branchId), queryFn: () => ratesApi.rateCard(branchId), enabled: signedIn });
}
/** This device's branch ('' when unregistered → shop-wide view). */
export const useDeviceBranch = () => useCurrentDevice().data?.branch_id ?? '';
