import { supabaseServer } from '@/lib/supabase/server';
import { updateOperator } from './actions';
import PasswordForm from './PasswordForm';
import IntegrationEndpoints from './IntegrationEndpoints';
import TemplateEditor from './TemplateEditor';
import { SEVERITY_OPTIONS } from './integration-actions';
import DashShell from '@/components/DashShell';

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

  const { data: endpoints } = await supa
    .from('integration_endpoints')
    .select('id, name, url, severity_threshold, enabled, created_at')
    .order('name');

  const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

  return (
    <DashShell title="Settings" width="narrow">
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
        <h2 className="font-semibold">Integration endpoints</h2>
        <p className="text-xs text-wx-mute">
          POST signed <code className="text-xs">alert.queued</code> JSON to county EMA or partner
          systems when alerts are queued. Header: <code className="text-xs">X-MidsouthWX-Signature</code>.
        </p>
        <IntegrationEndpoints
          endpoints={endpoints ?? []}
          severityOptions={SEVERITY_OPTIONS}
        />
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Templates</h2>
        <TemplateEditor templates={templates ?? []} />
      </section>
    </DashShell>
  );
}
