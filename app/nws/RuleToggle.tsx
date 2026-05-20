'use client';

import { useTransition } from 'react';
import { setAutoRuleEnabled } from './actions';

export default function RuleToggle({ ruleId, enabled }: { ruleId: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <label className="inline-flex items-center gap-2 cursor-pointer text-sm">
      <input
        type="checkbox"
        checked={enabled}
        disabled={pending}
        onChange={(e) => {
          startTransition(() => setAutoRuleEnabled(ruleId, e.target.checked));
        }}
      />
      <span className="text-wx-mute">{enabled ? 'On' : 'Off'}</span>
    </label>
  );
}
