/**
 * Smart Proxy & Backend Resolution Helper
 * Ensures the IPTV Web App works seamlessly both when deployed on full-stack Node/Cloud Run
 * AND when deployed as a static site on GitHub Pages (*.github.io), Vercel, Netlify, etc.
 */

const REMOTE_BACKEND_FALLBACK_URLS = [
  (import.meta as unknown as { env?: Record<string, string> })?.env?.VITE_API_BASE_URL || '',
  'https://ais-pre-xns2pdyjf3mio652yewbjq-960474134103.asia-southeast1.run.app',
  'https://ais-dev-xns2pdyjf3mio652yewbjq-960474134103.asia-southeast1.run.app',
].filter(Boolean);

let resolvedApiBaseUrl: string | null = null;
let backendAvailable = false;
let probePromise: Promise<string | null> | null = null;

/**
 * Detects if the current hostname is a known static-only hosting provider (like GitHub Pages)
 * where relative `/api/*` routes do not exist and would return 404 HTML pages.
 */
export function isStaticHostEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname.toLowerCase();
  const proto = window.location.protocol.toLowerCase();
  if (proto === 'file:' || proto === 'capacitor:' || proto === 'ionic:') {
    return true;
  }
  return (
    host.endsWith('.github.io') ||
    host.endsWith('.pages.dev') ||
    host.endsWith('.netlify.app') ||
    host.endsWith('.vercel.app') ||
    host.endsWith('.surge.sh') ||
    host.endsWith('.gitlab.io') ||
    host.endsWith('.firebaseapp.com') ||
    host.endsWith('.web.app')
  );
}

async function checkBackendUrl(baseUrl: string, timeoutMs = 3500): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Use /api/probe with empty query as a universal JSON health check (returns {"duration":null})
    const testUrl = `${baseUrl}/api/probe`;
    const res = await fetch(testUrl, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) return false;
    const data = await res.json();
    return data !== null && typeof data === 'object' && 'duration' in data;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Probes and caches the active backend base URL (`""` for same-origin Express server,
 * or remote Cloud Run URL when hosted on GitHub Pages, or `null` if no backend is reachable).
 */
export async function ensureBackendProbed(): Promise<string | null> {
  if (resolvedApiBaseUrl !== null || backendAvailable) {
    return resolvedApiBaseUrl;
  }
  if (probePromise) {
    return probePromise;
  }

  probePromise = (async () => {
    const candidates: string[] = [];
    if (!isStaticHostEnvironment()) {
      candidates.push('');
    }
    for (const remote of REMOTE_BACKEND_FALLBACK_URLS) {
      const cleaned = remote.replace(/\/+$/, '');
      if (!candidates.includes(cleaned)) {
        candidates.push(cleaned);
      }
    }

    for (const candidate of candidates) {
      const ok = await checkBackendUrl(candidate);
      if (ok) {
        resolvedApiBaseUrl = candidate;
        backendAvailable = true;
        return candidate;
      }
    }

    backendAvailable = false;
    resolvedApiBaseUrl = null;
    return null;
  })();

  return probePromise;
}

// Kick off background probe immediately on module load in browser
if (typeof window !== 'undefined') {
  ensureBackendProbed().catch(() => {});
}

/**
 * Synchronously returns the best known API base URL (`""` on full-stack host,
 * or remote fallback URL on GitHub Pages).
 */
export function getEffectiveApiBaseUrl(): string {
  if (resolvedApiBaseUrl !== null) {
    return resolvedApiBaseUrl;
  }
  if (isStaticHostEnvironment()) {
    return REMOTE_BACKEND_FALLBACK_URLS[0] || '';
  }
  return '';
}

/**
 * Returns whether the backend proxy/transcode server has been verified available,
 * or is expected to be available (when not yet finished probing).
 */
export function canUseBackendProxy(): boolean {
  if (backendAvailable) return true;
  // If probe hasn't finished yet and we're not on a static host without fallbacks, allow trying
  if (probePromise !== null && resolvedApiBaseUrl === null) {
    return !isStaticHostEnvironment() || REMOTE_BACKEND_FALLBACK_URLS.length > 0;
  }
  return false;
}

/**
 * Builds public CORS proxy URLs for fetching text/M3U/HLS manifests directly from the browser
 * when deployed on GitHub Pages or when backend proxy is unavailable.
 */
export function buildPublicCorsProxyUrls(targetUrl: string): string[] {
  if (!/^https?:\/\//i.test(targetUrl)) return [];
  return [
    `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
  ];
}

/**
 * Fetches a playlist / M3U / XSPF / XMLTV / JSON URL with automatic fallback across:
 * 1. Active Backend Proxy (if available)
 * 2. Direct Browser Fetch
 * 3. Public CORS Proxies (essential for GitHub Pages static deployments)
 */
export async function fetchWithUniversalFallback(
  targetUrl: string,
  proxyQuerySuffix: string
): Promise<Response> {
  const baseUrl = await ensureBackendProbed();

  // 1. If we are on a static host (like GitHub Pages), try Direct Fetch first for fast CORS-friendly URLs
  if (isStaticHostEnvironment()) {
    try {
      const directRes = await fetch(targetUrl);
      if (directRes.ok) return directRes;
    } catch {
      // continue to proxy fallbacks
    }
  }

  // 2. Try verified backend proxy (local or remote Cloud Run)
  if (baseUrl !== null) {
    try {
      const proxyRes = await fetch(`${baseUrl}/api/proxy?${proxyQuerySuffix}`);
      const ct = (proxyRes.headers.get('content-type') || '').toLowerCase();
      // Guard against static hosts returning 200/404 SPA index.html for /api/proxy
      const isSpaFallbackHtml =
        baseUrl === '' &&
        ct.includes('text/html') &&
        !targetUrl.toLowerCase().endsWith('.html');
      if (proxyRes.ok && !isSpaFallbackHtml) {
        return proxyRes;
      }
    } catch {
      // continue
    }
  }

  // 3. Try Direct Browser Fetch (if not already tried)
  if (!isStaticHostEnvironment()) {
    try {
      const directRes = await fetch(targetUrl);
      if (directRes.ok) return directRes;
    } catch {
      // continue
    }
  }

  // 4. Try Public CORS Proxies (ensures GitHub Pages can load any M3U/Xtream/VOD URL)
  const corsUrls = buildPublicCorsProxyUrls(targetUrl);
  for (const corsUrl of corsUrls) {
    try {
      const corsRes = await fetch(corsUrl);
      if (corsRes.ok) return corsRes;
    } catch {
      // try next CORS proxy
    }
  }

  throw new Error('Failed to fetch resource across all direct and proxy routes');
}
