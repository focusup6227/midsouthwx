'use client';

import {
  createTemplate,
  deleteTemplate,
  updateTemplate,
} from './template-actions';

type Template = {
  id: string;
  name: string;
  category: string | null;
  body_md: string;
  default_quick_replies: { label: string; data: string }[] | null;
};

function quickRepliesToJson(qr: Template['default_quick_replies']): string {
  if (!qr?.length) return '';
  return JSON.stringify(qr, null, 2);
}

export default function TemplateEditor({ templates }: { templates: Template[] }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-wx-mute">
        Use {'{{headline}}'}, {'{{event}}'}, {'{{area_desc}}'}, {'{{expires_at}}'} in the body.
        Compose fills these when sending.
      </p>

      {templates.length ? (
        <ul className="divide-y divide-wx-line">
          {templates.map((t) => (
            <li key={t.id} className="py-4 first:pt-0 last:pb-0">
              <details className="text-sm">
                <summary className="cursor-pointer font-medium flex items-center gap-2">
                  {t.name}
                  {t.category ? (
                    <span className="text-xs text-wx-mute font-normal">{t.category}</span>
                  ) : null}
                </summary>
                <form action={updateTemplate} className="mt-3 space-y-2">
                  <input type="hidden" name="id" value={t.id} />
                  <input className="input" name="name" defaultValue={t.name} required />
                  <input
                    className="input"
                    name="category"
                    defaultValue={t.category ?? ''}
                    placeholder="category (optional)"
                  />
                  <textarea
                    className="input font-mono text-xs"
                    name="body_md"
                    rows={5}
                    defaultValue={t.body_md}
                    required
                  />
                  <label className="block text-xs text-wx-mute">
                    Quick replies (JSON array)
                    <textarea
                      className="input font-mono text-xs mt-1"
                      name="quick_replies_json"
                      rows={3}
                      defaultValue={quickRepliesToJson(t.default_quick_replies)}
                      placeholder='[{"label":"✅ Safe","data":"safe"}]'
                    />
                  </label>
                  <div className="flex gap-2">
                    <button type="submit" className="btn-ghost text-sm">Save</button>
                  </div>
                </form>
                <form action={deleteTemplate} className="mt-2">
                  <input type="hidden" name="id" value={t.id} />
                  <button
                    type="submit"
                    className="btn-ghost text-xs text-wx-danger border-wx-danger/40"
                    onClick={(e) => {
                      if (!confirm(`Delete template "${t.name}"?`)) e.preventDefault();
                    }}
                  >
                    Delete
                  </button>
                </form>
              </details>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-wx-mute text-sm">No templates yet.</p>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer text-wx-accent font-medium">Add template</summary>
        <form action={createTemplate} className="mt-3 space-y-2">
          <input className="input" name="name" placeholder="Template name" required />
          <input className="input" name="category" placeholder="category (optional)" />
          <textarea
            className="input font-mono text-xs"
            name="body_md"
            rows={5}
            placeholder={`TORNADO WARNING — {{headline}}\n\n{{area_desc}}\n\nExpires: {{expires_at}}`}
            required
          />
          <textarea
            className="input font-mono text-xs"
            name="quick_replies_json"
            rows={3}
            placeholder='[{"label":"✅ Safe","data":"safe"}]'
          />
          <p className="text-xs text-wx-mute">
            Variables: {'{{headline}}'}, {'{{event}}'}, {'{{area_desc}}'}, {'{{expires_at}}'}
          </p>
          <button type="submit" className="btn text-sm">Add template</button>
        </form>
      </details>
    </div>
  );
}
