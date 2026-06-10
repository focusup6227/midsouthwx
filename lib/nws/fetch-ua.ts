// User-Agent for api.weather.gov fetches (AWC and mPING honor it too). NWS
// requires an identifying UA with contact info; reading the NWS_USER_AGENT
// secret here keeps the contact email configured in one place.
//
// Note: Supabase Edge Functions (Deno) keep their own copies — don't import
// this there.
export function nwsUserAgent(): string {
  return process.env.NWS_USER_AGENT || 'midsouthwx (contact: operator@midsouthwx)';
}
