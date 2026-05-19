import { supabaseServer } from '@/lib/supabase/server';
import Link from 'next/link';
import { updateOperator } from './actions';
import PasswordForm from './PasswordForm';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const supa = supabaseServer();

  const { data: userRes } = await supa.auth.getUser();
  const { data: op } = await supa
    .from('operators')
    .select('user_id, display_name, telegram_chat_id, created_at')
    .eq('user_id', userRes.user?.id ?? '')
    .maybeSingle();

  const { data: templates } = await supa
    .from('templates')
    .select('id, name, category, body_md, default_quick_replies, created_at')
    .order('name');

  const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

  return (
    <main className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <Link href="/dashboard" className="text-wx-mute text-sm">← Dashboard</Link>
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Operator profile</h2>
        <form action={updateOperator} className="space-y-3">
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">
              Display name
            </span>
            <input
              className="input"
              name="display_name"
              defaultValue={op?.display_name ?? userRes.user?.email ?? ''}
            />
          </label>
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">
              Telegram chat id (for self-notifications)
            </span>
            <input
              className="input"
              name="telegram_chat_id"
              type="number"
              defaultValue={op?.telegram_chat_id ?? ''}
              placeholder="Message @userinfobot on Telegram to find it"
            />
          </label>
          <p className="text-xs text-wx-mute">
            Signed in as <span className="text-wx-fg">{userRes.user?.email ?? '—'}</span>
          </p>
          <div className="flex justify-end">
            <button className="btn" type="submit">Save</button>
          </div>
        </form>
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Password</h2>
        <p className="text-xs text-wx-mute">
          Set a password to sign in without a magic link.
        </p>
        <PasswordForm />
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Bot</h2>
        {botUsername ? (
          <>
            <p className="text-sm">
              Bot: <span className="font-mono">@{botUsername}</span>
            </p>
            <p className="text-sm">
              Subscriber link format:{' '}
              <code className="text-xs bg-wx-ink px-1.5 py-0.5 rounded">
                https://t.me/{botUsername}?start=&lt;link_token&gt;
              </code>
            </p>
          </>
        ) : (
          <p className="text-sm text-wx-mute">
            Set <code>NEXT_PUBLIC_TELEGRAM_BOT_USERNAME</code> in <code>.env.local</code>.
          </p>
        )}
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Templates</h2>
        {templates?.length ? (
          <ul className="divide-y divide-wx-line">
            {templates.map((t) => (
              <li key={t.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{t.name}</span>
                  {t.category && (
                    <span className="text-xs text-wx-mute">{t.category}</span>
                  )}
                </div>
                <p className="text-xs text-wx-mute mt-1 whitespace-pre-wrap">
                  {t.body_md.slice(0, 140)}
                </p>
                {Array.isArray(t.default_quick_replies) && t.default_quick_replies.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {(t.default_quick_replies as { label: string; data: string }[]).map((qr, i) => (
                      <span key={i} className="text-xs px-1.5 py-0.5 rounded bg-wx-ink border border-wx-line">
                        {qr.label}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-wx-mute text-sm">No templates seeded.</p>
        )}
      </section>
    </main>
  );
}
