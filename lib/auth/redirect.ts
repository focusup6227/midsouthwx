export function safeRedirectPath(value: string | null | undefined, fallback = '/dashboard') {
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value;
}
