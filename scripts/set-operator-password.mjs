// Set the operator's password directly via the Supabase Admin API.
// Bypasses the recovery-email flow (useful when you've hit the email rate limit).
//
// Usage:
//   node scripts/set-operator-password.mjs <new-password> [email]
//
// Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '..', '.env.local');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const [, , password, emailArg] = process.argv;
if (!password) {
  console.error('Usage: node scripts/set-operator-password.mjs <new-password> [email]');
  process.exit(1);
}
const email = emailArg || 'tylerleedixon@gmail.com';

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

// Look up the user by email.
const listRes = await fetch(`${URL_}/auth/v1/admin/users?per_page=200`, { headers });
if (!listRes.ok) {
  console.error('List users failed:', listRes.status, await listRes.text());
  process.exit(1);
}
const list = await listRes.json();
const user = list.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`No user found for ${email}`);
  process.exit(1);
}

// Update password.
const updRes = await fetch(`${URL_}/auth/v1/admin/users/${user.id}`, {
  method: 'PUT',
  headers,
  body: JSON.stringify({ password }),
});
if (!updRes.ok) {
  console.error('Update failed:', updRes.status, await updRes.text());
  process.exit(1);
}

console.log(`Password set for ${email} (user id ${user.id}).`);
