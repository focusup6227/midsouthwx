import { supabaseServer } from '@/lib/supabase/server';
import { updateOperator, updateBriefingFocus } from './actions';
import PasswordForm from './PasswordForm';
import IntegrationEndpoints from './IntegrationEndpoints';
import TemplateEditor from './TemplateEditor';
import { SEVERITY_OPTIONS } from './integration-constants';
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

  const { data: focus } = await supa
    .from('app_settings')
    .select('briefing_focus_label, briefing_focus_lat, briefing_focus_lon, briefing_focus_radius_mi')
    .eq('id', true)
    .maybeSingle();

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
        <h2 className="font-semibold">Briefing focus area</h2>
        <p className="text-xs text-wx-mute">
          Centers the daily-briefing map and sets which area the SPC risk
          headline reflects — the &ldquo;highest risk&rdquo; badge uses the
          worst categorical band that touches this box, not the national peak.
          Defaults to Memphis. Tip: the Memphis (KNQA) radar is
          <span className="font-mono"> 35.34, -89.87</span>.
        </p>
        <form action={updateBriefingFocus} className="space-y-3">
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">
              Label
            </span>
            <input
              className="input"
              name="focus_label"
              defaultValue={focus?.briefing_focus_label ?? 'Memphis'}
              placeholder="Memphis"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">
                Center latitude
              </span>
              <input
                className="input"
                name="focus_lat"
                type="number"
                step="0.01"
                defaultValue={focus?.briefing_focus_lat ?? 35.34}
              />
            </label>
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">
                Center longitude
              </span>
              <input
                className="input"
                name="focus_lon"
                type="number"
                step="0.01"
                defaultValue={focus?.briefing_focus_lon ?? -89.87}
              />
            </label>
          </div>
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-wx-mute mb-1">
              Radius (miles)
            </span>
            <input
              className="input"
              name="focus_radius_mi"
              type="number"
              step="10"
              min={10}
              max={1000}
              defaultValue={focus?.briefing_focus_radius_mi ?? 200}
            />
            <span className="block text-[11px] text-wx-mute mt-1">
              Half-width of the square framed around the center (10–1000 mi).
            </span>
          </label>
          <div className="flex justify-end">
            <button className="btn" type="submit">Save focus area</button>
          </div>
        </form>
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
