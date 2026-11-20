import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useT } from '@/i18n';

/** TanStack Table with token styling. Columns carry already-translated headers. */
export function DataTable<T>({ columns, data, empty, caption }: { columns: Array<ColumnDef<T>>; data: T[]; empty?: string; caption?: string }) {
  const t = useT();
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="bg-muted">
          {table.getHeaderGroups().map((g) => (
            <tr key={g.id}>{g.headers.map((h) => <th key={h.id} className="px-3 py-2 text-left font-medium">{flexRender(h.column.columnDef.header, h.getContext())}</th>)}</tr>
          ))}
        </thead>
        <tbody className="divide-y divide-border">
          {table.getRowModel().rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="px-3 py-6 text-center text-muted-foreground">{empty ?? t('common.empty')}</td></tr>
          ) : table.getRowModel().rows.map((r) => (
            <tr key={r.id} className="hover:bg-muted/50">{r.getVisibleCells().map((c) => <td key={c.id} className="px-3 py-2 align-top">{flexRender(c.column.columnDef.cell, c.getContext())}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
