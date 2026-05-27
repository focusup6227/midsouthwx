'use server';

import { randomUUID } from 'node:crypto';
import { supabaseAdmin, supabaseServer } from '@/lib/supabase/server';

export type UploadResult =
  | { ok: true; url: string; type: 'animation' | 'photo' | 'video' | 'document' }
  | { ok: false; error: string };

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB — Telegram animation/video limit
const MIME_TO_TYPE: Record<string, 'animation' | 'photo' | 'video' | 'document'> = {
  'image/gif': 'animation',
  'video/mp4': 'animation',       // muted MP4 sent as animation reads like a GIF
  'video/quicktime': 'video',
  'image/png': 'photo',
  'image/jpeg': 'photo',
  'image/webp': 'photo',
};

/** Upload a compose-media file to the `compose-media` bucket. Returns a
 *  public URL that the send-worker hands to Telegram. Operator-gated via the
 *  RLS-respecting supabaseServer client (the bucket policies also enforce). */
export async function uploadComposeMedia(formData: FormData): Promise<UploadResult> {
  const supa = supabaseServer();
  const { data: userRes } = await supa.auth.getUser();
  const userId = userRes.user?.id;
  if (!userId) return { ok: false, error: 'not authenticated' };
  const { data: op } = await supa.from('operators').select('user_id').eq('user_id', userId).maybeSingle();
  if (!op) return { ok: false, error: 'operators only' };

  const file = formData.get('file');
  if (!(file instanceof File)) return { ok: false, error: 'no file' };
  if (file.size === 0) return { ok: false, error: 'empty file' };
  if (file.size > MAX_BYTES) return { ok: false, error: `file too large (max ${MAX_BYTES / 1024 / 1024}MB)` };

  const mime = file.type || 'application/octet-stream';
  const mediaType = MIME_TO_TYPE[mime] ?? 'document';

  const ext = (() => {
    const i = file.name.lastIndexOf('.');
    return i >= 0 ? file.name.slice(i).toLowerCase() : '';
  })();
  const safeExt = /^[.A-Za-z0-9]{1,8}$/.test(ext) ? ext : '';
  const path = `${userId}/${randomUUID()}${safeExt}`;

  const admin = supabaseAdmin();
  const { error: upErr } = await admin.storage
    .from('compose-media')
    .upload(path, file, { contentType: mime, cacheControl: '3600', upsert: false });
  if (upErr) return { ok: false, error: upErr.message };

  const { data: pub } = admin.storage.from('compose-media').getPublicUrl(path);
  if (!pub?.publicUrl) return { ok: false, error: 'failed to read public url' };
  return { ok: true, url: pub.publicUrl, type: mediaType };
}
