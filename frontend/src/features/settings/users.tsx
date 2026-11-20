import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Check as CheckIcon, KeyRound, Minus, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Field, Select } from '@/components/ui/field';
import { formatDateTimeIN } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { ErrorText, OfflineBanner, PageHeader } from '@/components/page';
import { useT, useTk } from '@/i18n';
import { ok, ifMatch } from '@/lib/api/fetcher';
import { createUser, getListPermissionsQueryKey, getListRolesQueryKey, getListUsersQueryKey, listPermissions, listRoles, listUsers, setUserRoles, updateUser } from '@/lib/api/backend/users/users';
import type { RoleAssignment, SystemRoleCode, User, UserPatch } from '@/lib/api/backend/model';
import { useOnline } from '@/lib/offline/connectivity';
import { useBranches } from '@/features/devices/devices';
import { useCan, useSession } from '@/lib/session';
import { ResetPasswordDrawer } from '@/features/auth/password';
import { ROUTE_PERMS } from '@/lib/permissions';

/** GET /v1/users needs platform.users.manage; without it the step shows a note and never fires the query. */
export const USERS_PERM: string = ROUTE_PERMS['/settings/users'] ?? 'platform.users.manage';

export const PRESET_ROLES = ['owner', 'manager', 'salesperson', 'cashier'] as const satisfies readonly SystemRoleCode[];
interface Form { name: string; login: string; password: string; role: SystemRoleCode; branch: string }
const blank = (): Form => ({ name: '', login: '', password: '', role: 'salesperson', branch: '' });
/** Owner is shop-wide; other roles are scoped to one branch. */
const assignment = (role: SystemRoleCode, branch: string): RoleAssignment[] => [role === 'owner' || !branch ? { role } : { role, branch_id: branch }];

/** P5 users with PRESET roles only (custom roles = P6 Later, not built). Login = username or 10–15 digit mobile. */
export function UsersManager() {
  const t = useT();
  const tk = useTk();
  const qc = useQueryClient();
  const online = useOnline();
  const canManage = useCan()(USERS_PERM);
  const users = useQuery({ queryKey: getListUsersQueryKey(), queryFn: () => ok(listUsers()), enabled: canManage });
  const branches = useBranches();
  const [f, setF] = useState<Form>(blank());
  const [resetFor, setResetFor] = useState<User | null>(null);
  const myId = useSession().data?.user.id;
  const inval = () => { void qc.invalidateQueries({ queryKey: getListUsersQueryKey() }); void qc.invalidateQueries({ queryKey: ['/v1/onboarding'] }); };
  const isPhone = /^[0-9]{10,15}$/.test(f.login);
  const loginOk = isPhone || /^[a-z0-9._-]{3,40}$/.test(f.login);
  const add = useMutation({
    mutationFn: () => {
      const branch = f.branch || branches.data?.[0]?.id || '';
      return ok(createUser({ name: f.name.trim(), ...(isPhone ? { phone: f.login } : { username: f.login }), password: f.password, default_branch_id: branch || undefined, roles: assignment(f.role, branch) }));
    },
    onSuccess: () => { setF(blank()); inval(); },
  });
  // If-Match = user version (also bumps on failed logins → 412 means reload).
  const patch = useMutation({ mutationFn: ({ u, p }: { u: User; p: UserPatch }) => ok(updateUser(u.id, p, ifMatch(u.version))), onSuccess: inval, onError: inval });
  const roles = useMutation({ mutationFn: ({ u, role }: { u: User; role: SystemRoleCode }) => ok(setUserRoles(u.id, assignment(role, u.default_branch_id ?? u.roles[0]?.branch_id ?? ''))), onSuccess: inval });
  const branchName = (id?: string | null) => branches.data?.find((b) => b.id === id)?.name;
  const columns: Array<ColumnDef<User>> = [
    { header: t('user.name'), cell: (c) => <div><p className="font-medium">{c.row.original.name}</p><p className="font-mono text-xs text-muted-foreground">{c.row.original.username ?? c.row.original.phone}</p></div> },
    { header: t('user.role'), cell: (c) => (
      <Select aria-label={t('user.role')} className="h-8 min-h-0" value={c.row.original.roles[0]?.role ?? 'salesperson'} disabled={!online}
        onChange={(e) => roles.mutate({ u: c.row.original, role: e.target.value as SystemRoleCode })}>
        {PRESET_ROLES.map((r) => <option key={r} value={r}>{tk(`role.${r}`)}</option>)}
      </Select>) },
    { header: t('user.branches'), cell: (c) => [...new Set(c.row.original.roles.map((r) => (r.branch_id ? branchName(r.branch_id) : t('user.allBranches'))))].filter(Boolean).join(', ') },
    { header: t('user.locked'), cell: (c) => (c.row.original.locked_until && new Date(c.row.original.locked_until) > new Date() ? <Badge variant="warning">{formatDateTimeIN(c.row.original.locked_until)}</Badge> : null) },
    { header: t('common.status'), cell: (c) => <Badge variant={c.row.original.is_active ? 'success' : 'outline'}>{t(c.row.original.is_active ? 'common.active' : 'common.inactive')}</Badge> },
    { id: 'a', header: '', cell: (c) => (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={c.row.original.is_active ? 'outline' : 'default'} disabled={!online} onClick={() => patch.mutate({ u: c.row.original, p: { is_active: !c.row.original.is_active } })}>
          {t(c.row.original.is_active ? 'user.deactivate' : 'user.activate')}
        </Button>
        {/* Own password: use "Change my password" (needs the current one) — resetting yourself would end this session. */}
        {c.row.original.id !== myId ? (
          <Button size="sm" variant="ghost" disabled={!online} data-testid="reset-password" onClick={() => setResetFor(c.row.original)}>
            <KeyRound className="h-4 w-4" aria-hidden />{t('password.reset.action')}
          </Button>) : null}
      </div>) },
  ];
  if (!canManage) return <p role="note" data-testid="users-no-access" className="rounded-md border border-border bg-muted p-2 text-sm text-muted-foreground">{t('user.noAccess')}</p>;
  return (
    <div className="space-y-4">
      <DataTable columns={columns} data={users.data ?? []} caption={t('user.title')} />
      <ErrorText error={patch.error ?? roles.error} />
      <ResetPasswordDrawer user={resetFor} onClose={() => { setResetFor(null); inval(); }} />
      <Card>
        <CardHeader><CardTitle>{t('user.add')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-5">
            <Field label={t('user.name')}>{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
            <Field label={t('user.login')} hint={t('user.loginHint')} error={f.login && !loginOk ? t('validation.login') : null}>
              {(id, d) => <Input id={id} aria-describedby={d} className="font-mono" value={f.login} onChange={(e) => setF({ ...f, login: e.target.value.trim().toLowerCase() })} />}</Field>
            <Field label={t('user.tempPassword')} hint={t('user.tempPasswordHint')}>
              {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />}</Field>
            <Field label={t('user.role')}>{(id) => (
              <Select id={id} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as SystemRoleCode })}>
                {PRESET_ROLES.map((r) => <option key={r} value={r}>{tk(`role.${r}`)}</option>)}
              </Select>)}</Field>
            <Field label={t('user.branch')}>{(id) => (
              <Select id={id} value={f.branch} onChange={(e) => setF({ ...f, branch: e.target.value })}>
                <option value="" disabled>{t('common.choose')}</option>
                {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>)}</Field>
          </div>
          <ErrorText error={add.error} />
          <Button disabled={!online || !f.name.trim() || !loginOk || f.password.length < 8 || add.isPending} onClick={() => add.mutate()}>{t('user.add')}</Button>
        </CardContent>
      </Card>
    </div>
  );
}

export function UsersPage() {
  const t = useT();
  return <div><PageHeader title={t('user.title')} description={t('user.description')} /><OfflineBanner /><UsersManager /></div>;
}

/** Sensitive = money/stock/identity-affecting; the contract has no flag, so the UI marks these patterns. */
const SENSITIVE = /(void|cancel|approve|discount|users\.manage|settings\.edit|rates\.publish|import|audit)/;

/** P5 + P7: read-only preset role matrix; sensitive actions flagged. */
export function RolesPage() {
  const t = useT();
  const tk = useTk();
  const roles = useQuery({ queryKey: getListRolesQueryKey(), queryFn: () => ok(listRoles()) });
  const perms = useQuery({ queryKey: getListPermissionsQueryKey(), queryFn: () => ok(listPermissions()) });
  const order = perms.data ?? [...new Set((roles.data ?? []).flatMap((r) => r.permissions))].map((code) => ({ code, module: '', description: code }));
  return (
    <div className="space-y-4">
      <PageHeader title={t('roles.title')} description={t('roles.description')} />
      <Card>
        <CardContent className="overflow-x-auto pt-4">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border"><th className="py-2 text-left">{t('roles.permission')}</th>
              {roles.data?.map((r) => <th key={r.code} className="px-3 py-2 text-center">{tk(`role.${r.code}`)}</th>)}</tr></thead>
            <tbody className="divide-y divide-border">
              {order.map((p) => (
                <tr key={p.code}>
                  <td className="py-2">
                    <span>{p.description}</span>{' '}<span className="font-mono text-xs text-muted-foreground">{p.code}</span>
                    {SENSITIVE.test(p.code) ? <Badge variant="warning" className="ml-2"><ShieldAlert className="mr-1 h-3 w-3" aria-hidden />{t('roles.sensitive')}</Badge> : null}
                  </td>
                  {roles.data?.map((r) => {
                    const has = r.permissions.includes(p.code);
                    return <td key={r.code} className="px-3 py-2 text-center">{has
                      ? <CheckIcon className="mx-auto h-4 w-4 text-success" aria-label={t('roles.allowed')} />
                      : <Minus className="mx-auto h-4 w-4 text-muted-foreground" aria-label={t('roles.notAllowed')} />}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">{t('roles.customLater')}</p>
    </div>
  );
}
