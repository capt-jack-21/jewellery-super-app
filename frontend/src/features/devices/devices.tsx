import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Field, Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorText, OfflineBanner, PageHeader } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { ok } from '@/lib/api/fetcher';
import {
  approveDevice, getCurrentDevice, getGetCurrentDeviceQueryKey, getListDevicesQueryKey, listDevices, registerDevice, revokeDevice,
} from '@/lib/api/backend/devices/devices';
import { listBranches, getListBranchesQueryKey } from '@/lib/api/backend/tenant/tenant';
import type { Device, DeviceKind } from '@/lib/api/backend/model';
import { deviceKey } from '@/lib/device-key';
import { formatDateTimeIN } from '@/lib/format';
import { useOnline } from '@/lib/offline/connectivity';
import { useCan, useSignedIn } from '@/lib/session';

const KINDS: DeviceKind[] = ['billing_counter', 'tablet', 'mobile', 'back_office'];
const statusVariant = { pending: 'warning', approved: 'success', revoked: 'destructive' } as const;

/** Revoking this browser's own device ends its session: warn first. */
export const isCurrentDevice = (id: string, currentId: string | null | undefined): boolean => !!currentId && id === currentId;

export function useCurrentDevice() {
  const signedIn = useSignedIn();
  return useQuery({
    enabled: signedIn,
    queryKey: getGetCurrentDeviceQueryKey(),
    // 0.4.3: an unregistered browser gets 200 null (no 404), so null simply means "not registered".
    queryFn: () => ok(getCurrentDevice()),
  });
}
export function useBranches() {
  const signedIn = useSignedIn();
  return useQuery({ queryKey: getListBranchesQueryKey(), queryFn: () => ok(listBranches()), enabled: signedIn });
}

/** P10: this browser's registration card (request → owner/manager approves). Used on the counter and settings. */
export function ThisDeviceCard() {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const current = useCurrentDevice();
  const branches = useBranches();
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('');
  const [kind, setKind] = useState<DeviceKind>('billing_counter');
  const reg = useMutation({
    mutationFn: () => ok(registerDevice({ name: name.trim(), kind, branch_id: branch || branches.data?.[0]?.id || '', device_key: deviceKey() })),
    onSuccess: () => qc.invalidateQueries({ queryKey: getListDevicesQueryKey() }).then(() => qc.invalidateQueries({ queryKey: getGetCurrentDeviceQueryKey() })),
  });
  const d = current.data;
  return (
    <Card data-testid="this-device">
      <CardHeader><CardTitle>{t('device.this.title')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {d && d.status !== 'revoked' ? (
          <div className="space-y-1 text-sm">
            <p><span className="font-medium">{d.name}</span>{' '}<Badge variant={statusVariant[d.status]}>{tk(`device.status.${d.status}`)}</Badge></p>
            <p className="text-muted-foreground">{t(d.status === 'approved' ? 'device.this.approved' : 'device.this.pending')}</p>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t('device.this.unregistered')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('device.name')} hint={t('device.nameHint')}>{(id, h) => <Input id={id} aria-describedby={h} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />}</Field>
              <Field label={t('device.branch')}>{(id) => (
                <Select id={id} value={branch} onChange={(e) => setBranch(e.target.value)}>
                  {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>)}
              </Field>
              <Field label={t('device.kind')}>{(id) => (
                <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as DeviceKind)}>
                  {KINDS.map((k) => <option key={k} value={k}>{tk(`device.kind.${k}`)}</option>)}
                </Select>)}
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">{t('device.reloginNote')}</p>
            <ErrorText error={reg.error} />
            <Button disabled={!online || !name.trim() || reg.isPending} onClick={() => reg.mutate()}>{t('device.register')}</Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function DevicesPage() {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const can = useCan();
  const online = useOnline();
  const devices = useQuery({ queryKey: getListDevicesQueryKey(), queryFn: () => ok(listDevices()) });
  const branches = useBranches();
  const current = useCurrentDevice();
  const act = useMutation({
    mutationFn: ({ id, a }: { id: string; a: 'approve' | 'revoke' }) => ok(a === 'approve' ? approveDevice(id) : revokeDevice(id, { reason: window.prompt(t('device.revokeReason')) ?? undefined })),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: getListDevicesQueryKey() }), qc.invalidateQueries({ queryKey: getGetCurrentDeviceQueryKey() })]),
  });
  const revoke = (id: string) => {
    if (isCurrentDevice(id, current.data?.id) && !window.confirm(t('device.revokeSelfConfirm'))) return;
    act.mutate({ id, a: 'revoke' });
  };
  const branchName = (id: string) => branches.data?.find((b) => b.id === id)?.name ?? '';
  const columns: Array<ColumnDef<Device>> = [
    { header: t('device.name'), accessorKey: 'name', cell: (c) => <div><p className="font-medium">{c.row.original.name}</p><p className="text-xs text-muted-foreground">{tk(`device.kind.${c.row.original.kind}`)}</p></div> },
    { header: t('device.branch'), cell: (c) => branchName(c.row.original.branch_id) },
    { header: t('common.status'), cell: (c) => <Badge variant={statusVariant[c.row.original.status]}>{tk(`device.status.${c.row.original.status}`)}</Badge> },
    { header: t('device.requested'), cell: (c) => formatDateTimeIN(c.row.original.created_at) },
    { header: t('device.lastSeen'), cell: (c) => (c.row.original.last_seen_at ? formatDateTimeIN(c.row.original.last_seen_at) : '—') },
    { header: t('device.sessions'), cell: (c) => <span className="tabular-nums">{c.row.original.live_sessions ?? 0}</span> },
    { id: 'actions', header: '', cell: (c) => {
      const d = c.row.original;
      if (!can('platform.devices.approve')) return null;
      return (
        <div className="flex gap-2">
          {d.status === 'pending' ? <Button size="sm" disabled={!online} onClick={() => act.mutate({ id: d.id, a: 'approve' })}>{t('device.approve')}</Button> : null}
          {d.status !== 'revoked' ? <Button size="sm" variant="destructive" disabled={!online} onClick={() => revoke(d.id)}>{t('device.revoke')}</Button> : null}
        </div>
      );
    } },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title={t('device.title')} description={t('device.description')} />
      <OfflineBanner />
      <ThisDeviceCard />
      <ErrorText error={act.error} />
      <DataTable columns={columns} data={devices.data ?? []} caption={t('device.title')} />
    </div>
  );
}

/** /device: device registration for the current browser (P10), shown after first login on a new counter. */
export function DevicePage() {
  const t = useT();
  return <div className="space-y-4"><PageHeader title={t('device.registerTitle')} description={t('device.registerDescription')} /><OfflineBanner /><ThisDeviceCard /></div>;
}
