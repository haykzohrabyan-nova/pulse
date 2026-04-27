/**
 * CORS helpers for Pulse Supabase Edge Functions.
 * Frontend origins: pulse.bazaar-admin.com, pulse-staging.bazaar-admin.com,
 * and localhost for local dev.
 */

const ALLOWED_ORIGINS = new Set([
  "https://pulse.bazaar-admin.com",
  "https://pulse-staging.bazaar-admin.com",
  "http://localhost",
  "http://127.0.0.1",
  // Cloudflare Pages preview URLs follow *.pages.dev pattern — handled below
]);

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Allow Cloudflare Pages preview deployments
  if (/^https:\/\/[\w-]+\.pages\.dev$/.test(origin)) return true;
  // Allow localhost on any port for dev
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

export function corsHeaders(requestOrigin: string | null): Record<string, string> {
  const origin = isAllowedOrigin(requestOrigin) ? requestOrigin! : "null";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

/** Handle OPTIONS preflight — return 204 with CORS headers */
export function handlePreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("Origin");
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin),
    });
  }
  return null;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  origin: string | null = null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

export function errorResponse(
  message: string,
  status = 400,
  origin: string | null = null,
): Response {
  return jsonResponse({ error: message }, status, origin);
}
