// Shared Inter font loader for next/og (Satori) social cards. Each consuming
// edge route bundles these .woff assets via the import.meta.url references
// below, so all card routes render with the same crisp weights without
// duplicating the font files per route folder.

export type OgFont = {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 600 | 700;
  style: 'normal';
};

export async function loadCardFonts(): Promise<OgFont[]> {
  const [regular, semibold, bold] = await Promise.all([
    fetch(new URL('./Inter-Regular.woff', import.meta.url)).then((r) => r.arrayBuffer()),
    fetch(new URL('./Inter-SemiBold.woff', import.meta.url)).then((r) => r.arrayBuffer()),
    fetch(new URL('./Inter-Bold.woff', import.meta.url)).then((r) => r.arrayBuffer()),
  ]);
  return [
    { name: 'Inter', data: regular, weight: 400, style: 'normal' },
    { name: 'Inter', data: semibold, weight: 600, style: 'normal' },
    { name: 'Inter', data: bold, weight: 700, style: 'normal' },
  ];
}
