'use client';

import { useMemo, useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';

type Props = {
  title: string;
  hazards: string[];
  confidence: string | null;
  validFrom: string;
  validUntil: string;
  discussion: string | null;
  shareUrl: string | null;
  area: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
};

type Platform = 'telegram' | 'facebook' | 'plain';

const HAZARD_EMOJI: Record<string, string> = {
  tornado: '🌪️', severe: '⛈️', wind: '💨', flood: '🌊', winter: '❄️', heat: '🥵',
};
const HAZARD_LABEL: Record<string, string> = {
  tornado: 'Tornado', severe: 'Severe storms', wind: 'Damaging wind', flood: 'Flooding',
  winter: 'Winter weather', heat: 'Extreme heat',
};

function fmt(dt: string): string {
  return new Date(dt).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// Trim discussion to a clean N-sentence lead for the concise formats.
function lead(text: string | null, sentences: number): string {
  if (!text) return '';
  const parts = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+/g);
  if (!parts) return text.trim();
  return parts.slice(0, sentences).join(' ').trim();
}

export default function DistributePanel({
  title, hazards, confidence, validFrom, validUntil, discussion, shareUrl, area,
}: Props) {
  const [platform, setPlatform] = useState<Platform>('telegram');
  const [copied, setCopied] = useState(false);

  const bot = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
  const subscribeLine = bot ? `Get these alerts free on Telegram → t.me/${bot}` : null;

  // Static map of the forecast area (Mapbox Static Images API) for attaching.
  const imageUrl = useMemo(() => {
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token || !area) return null;
    const overlay = {
      type: 'Feature',
      properties: { fill: '#f97316', 'fill-opacity': 0.25, stroke: '#f97316', 'stroke-width': 2 },
      geometry: area,
    };
    const enc = encodeURIComponent(JSON.stringify(overlay));
    return `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/geojson(${enc})/auto/700x440@2x?access_token=${token}&padding=40`;
  }, [area]);

  const text = useMemo(() => {
    const hz = hazards.length ? hazards : [];
    if (platform === 'telegram') {
      // Clean, scannable, Telegram-friendly. Attach the area image when sending.
      const lines = [
        `🌩️ ${title}`,
        hz.length ? hz.map((h) => `${HAZARD_EMOJI[h] ?? '•'} ${HAZARD_LABEL[h] ?? h}`).join('  ') : '',
        `🕒 ${fmt(validFrom)} → ${fmt(validUntil)}`,
        confidence ? `🎯 Confidence: ${confidence}` : '',
        '',
        lead(discussion, 3),
        shareUrl ? `\n🔗 ${shareUrl}` : '',
      ];
      return lines.filter((l) => l !== '').join('\n');
    }
    if (platform === 'facebook') {
      // Fancier, fuller, with hashtags + CTA.
      const lines = [
        `⚠️ ${title.toUpperCase()} ⚠️`,
        '📍 Mid-South (TN / MS / AR)',
        '',
        hz.length ? `Threats:\n${hz.map((h) => `  ${HAZARD_EMOJI[h] ?? '•'} ${HAZARD_LABEL[h] ?? h}`).join('\n')}` : '',
        confidence ? `🎯 Confidence: ${confidence[0].toUpperCase()}${confidence.slice(1)}` : '',
        `🕒 Valid: ${fmt(validFrom)} → ${fmt(validUntil)}`,
        '',
        discussion?.trim() ?? '',
        '',
        subscribeLine ? `✅ ${subscribeLine}` : '',
        shareUrl ? `📄 Full discussion: ${shareUrl}` : '',
        '',
        '#mswx #tnwx #arwx #mswx #wxtwitter #severewx',
      ];
      return lines.filter((l) => l !== '').join('\n');
    }
    // plain
    const lines = [
      title,
      hz.length ? `Hazards: ${hz.map((h) => HAZARD_LABEL[h] ?? h).join(', ')}` : '',
      confidence ? `Confidence: ${confidence}` : '',
      `Valid: ${fmt(validFrom)} - ${fmt(validUntil)}`,
      '',
      discussion?.trim() ?? '',
      shareUrl ? `\n${shareUrl}` : '',
    ];
    return lines.filter((l) => l !== '').join('\n');
  }, [platform, title, hazards, confidence, validFrom, validUntil, discussion, shareUrl, subscribeLine]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked; the textarea is selectable as fallback */
    }
  }

  const TABS: { key: Platform; label: string }[] = [
    { key: 'telegram', label: 'Telegram' },
    { key: 'facebook', label: 'Facebook' },
    { key: 'plain', label: 'Plain text' },
  ];

  return (
    <div className="space-y-3 rounded-lg border border-wx-line bg-wx-card p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">Distribute</div>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md border border-wx-line bg-wx-ink px-2 py-1 text-[11px] text-wx-mute hover:text-wx-fg hover:border-wx-accent"
        >
          {copied ? <Check size={11} className="text-wx-ok" /> : <Copy size={11} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setPlatform(t.key)}
            className={`rounded-md px-2.5 py-1 text-xs ${
              platform === t.key ? 'bg-wx-accent/15 text-wx-fg ring-1 ring-wx-accent' : 'text-wx-mute hover:text-wx-fg hover:bg-wx-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <textarea
        readOnly
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        className="h-56 w-full resize-y rounded-md border border-wx-line bg-wx-ink p-2.5 font-mono text-[12px] leading-relaxed text-wx-fg outline-none focus:border-wx-accent"
      />

      {imageUrl ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-wx-mute">Area image (attach)</div>
            <a
              href={imageUrl}
              download={`forecast-area.png`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-wx-mute hover:text-wx-accent"
            >
              <Download size={11} /> Download
            </a>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="Forecast area" className="w-full rounded-md border border-wx-line" loading="lazy" />
        </div>
      ) : null}

      <p className="text-[10px] text-wx-mute">
        {platform === 'telegram'
          ? 'Clean + scannable. Use “Broadcast” to send to subscribers, or copy to post manually with the area image.'
          : platform === 'facebook'
            ? 'Longer, with hashtags + subscribe CTA. Copy and paste into a Facebook post; attach the area image.'
            : 'Unformatted — paste anywhere (SMS, email, other platforms).'}
      </p>
    </div>
  );
}
