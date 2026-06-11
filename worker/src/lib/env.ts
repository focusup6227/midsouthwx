// Node replacement for Deno.env.get — same semantics (string | undefined).
export function env(name: string): string | undefined {
  return process.env[name];
}
