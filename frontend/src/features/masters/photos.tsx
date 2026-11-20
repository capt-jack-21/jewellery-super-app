import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ImagePlus, Star, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EditGate, ErrorText } from '@/components/page';
import { useT } from '@/i18n';
import { ApiError } from '@/lib/api/fetcher';
import type { Design, DesignPhoto } from '@/lib/api/backend/model';
import { mastersApi, mastersKeys } from './api';
import { PhotoThumb } from './master-screen';
import { editPermOf } from './registry';
import type { MasterRow } from './types';

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_PHOTOS = 8;

/** Client checks mirroring the contract (JPEG/PNG/WebP, ≤ 5 MB, ≤ 8 per design; tags pass max 10). Returns an error key or null. */
export function checkPhotos(existing: number, files: Array<Pick<File, 'type' | 'size'>>, max = MAX_PHOTOS): 'masters.photoInvalid' | 'masters.photoTooMany' | null {
  if (files.some((f) => !PHOTO_TYPES.includes(f.type) || f.size > PHOTO_MAX_BYTES)) return 'masters.photoInvalid';
  return existing + files.length > max ? 'masters.photoTooMany' : null;
}

/** Sorted by sort_order; the cover is the photo marked is_primary (else the first). */
export const sortPhotos = (ps: DesignPhoto[]) => [...ps].sort((x, y) => x.sort_order - y.sort_order);
export const coverOf = (ps: DesignPhoto[]) => ps.find((p) => p.is_primary) ?? ps[0];
/** New order after moving index i by d (−1 up, +1 down); unchanged at the ends. */
export function moved<T>(list: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j] as T, out[i] as T];
  return out;
}

/**
 * M4 design photos (contract 0.7.0): bytes go to POST /v1/files (purpose design_photo), then the file is attached.
 * Reorder / "Make cover" is one PATCH listing EVERY photo once, with If-Match on the design version
 * (422 photo_set_mismatch or 412 → reload). Removing uses the photo's own version (204).
 */
export function PhotosPanel({ design, onChanged }: { design: MasterRow; onChanged: (r: MasterRow) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState(design);
  const key = ['masters', 'designs', design.id, 'photos'] as const;
  const photos = useQuery({ queryKey: key, queryFn: () => mastersApi.listPhotos(design.id), select: sortPhotos, retry: false });
  const list = photos.data ?? [];
  const cover = coverOf(list);
  const [previews, setPreviews] = useState<Array<{ name: string; url: string }>>([]);
  const [localErr, setLocalErr] = useState<string | null>(null);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);
  const apply = (r: MasterRow) => { setCurrent(r); onChanged(r); void qc.invalidateQueries({ queryKey: mastersKeys.kind('designs') }); };
  const refresh = async () => { await qc.invalidateQueries({ queryKey: key }); apply(await mastersApi.get('designs', design.id)); };
  const onErr = (e: unknown) => { if (e instanceof ApiError && (e.isStale || e.code === 'photo_set_mismatch')) void refresh(); };
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      setPreviews(files.map((f) => ({ name: f.name, url: URL.createObjectURL(f) })));
      let n = list.length;
      for (const f of files) {
        const file = await mastersApi.uploadFile(f, 'design_photo');
        await mastersApi.attachPhoto(design.id, { file_id: file.id, caption: null, is_primary: n === 0, sort_order: n });
        n += 1;
      }
    },
    onError: onErr, onSettled: () => { setPreviews([]); void refresh(); },
  });
  const reorder = useMutation({
    mutationFn: ({ order, coverId }: { order: DesignPhoto[]; coverId?: string }) =>
      mastersApi.reorderPhotos(current as Pick<Design, 'id' | 'version'>, order.map((p) => p.file_id), coverId),
    onSuccess: (r) => { qc.setQueryData(key, r.photos); apply({ ...current, version: r.design_version }); },
    onError: onErr,
  });
  const remove = useMutation({ mutationFn: (p: DesignPhoto) => mastersApi.removePhoto(design.id, p), onSettled: () => void refresh(), onError: onErr });
  const busy = upload.isPending || reorder.isPending || remove.isPending;
  const pick = (fl: FileList | null) => {
    const files = Array.from(fl ?? []);
    const err = checkPhotos(list.length, files);
    setLocalErr(err ? t(err, { max: MAX_PHOTOS }) : null);
    if (!err && files.length) upload.mutate(files);
    if (input.current) input.current.value = '';
  };
  return (
    <section aria-labelledby="photos-h" className="space-y-3 border-t border-border pt-4" data-testid="photos-panel">
      <h3 id="photos-h" className="font-heading font-semibold">{t('masters.photos')}</h3>
      <p className="text-xs text-muted-foreground">{t('masters.photosHint', { max: MAX_PHOTOS })}</p>
      <EditGate perm={editPermOf('designs')}>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {list.map((p, i) => {
            const n = t('masters.photoN', { n: i + 1 });
            return (
              <li key={p.id} className="space-y-1 rounded-md border border-border p-1" data-testid="photo">
                <div className="relative">
                  <PhotoThumb fileId={p.file_id} alt={n} className="aspect-square w-full rounded object-cover" />
                  {p === cover ? <span className="absolute left-1 top-1 rounded bg-primary px-1.5 text-xs text-primary-foreground">{t('masters.cover')}</span> : null}
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  <Button type="button" size="icon" variant="ghost" aria-label={`${t('masters.moveUp')} ${n}`} disabled={busy || i === 0}
                    onClick={() => reorder.mutate({ order: moved(list, i, -1), coverId: cover?.file_id })}><ArrowUp className="h-4 w-4" /></Button>
                  <Button type="button" size="icon" variant="ghost" aria-label={`${t('masters.moveDown')} ${n}`} disabled={busy || i === list.length - 1}
                    onClick={() => reorder.mutate({ order: moved(list, i, 1), coverId: cover?.file_id })}><ArrowDown className="h-4 w-4" /></Button>
                  {p === cover ? null : (
                    <Button type="button" size="icon" variant="ghost" aria-label={`${t('masters.makeCover')} ${n}`} disabled={busy}
                      onClick={() => reorder.mutate({ order: list, coverId: p.file_id })}><Star className="h-4 w-4" /></Button>
                  )}
                  <Button type="button" size="icon" variant="ghost" aria-label={`${t('common.remove')} ${n}`} disabled={busy}
                    onClick={() => remove.mutate(p)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </li>
            );
          })}
          {previews.map((p) => (
            <li key={p.url} className="rounded-md border border-dashed border-border p-1 opacity-60" aria-busy="true">
              <img src={p.url} alt={p.name} className="aspect-square w-full rounded object-cover" />
            </li>
          ))}
        </ul>
        <input ref={input} type="file" accept={PHOTO_TYPES.join(',')} multiple className="sr-only" id="photo-input" aria-label={t('masters.addPhotos')} onChange={(e) => pick(e.target.files)} />
        <Button type="button" variant="outline" disabled={busy || list.length >= MAX_PHOTOS} onClick={() => input.current?.click()}>
          <ImagePlus className="mr-1 h-4 w-4" />{t(upload.isPending ? 'masters.uploading' : 'masters.addPhotos')}
        </Button>
        {localErr ? <p role="alert" className="text-sm text-destructive">{localErr}</p> : null}
        <ErrorText error={photos.error ?? upload.error ?? reorder.error ?? remove.error} />
      </EditGate>
    </section>
  );
}
