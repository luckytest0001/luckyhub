/**
 * Smart Proxy & Backend Resolution Helper
 * Ensures the IPTV Web App works seamlessly both when deployed on full-stack Node/Cloud Run
 * AND when deployed as a static site on GitHub Pages (*.github.io), Vercel, Netlify, or custom domains.
 */

import type { Channel } from './playlistParser';

const REMOTE_BACKEND_FALLBACK_URLS = [
  (import.meta as unknown as { env?: Record<string, string> })?.env?.VITE_API_BASE_URL || '',
  'https://ais-pre-xns2pdyjf3mio652yewbjq-960474134103.asia-southeast1.run.app',
  'https://ais-dev-xns2pdyjf3mio652yewbjq-960474134103.asia-southeast1.run.app',
].filter(Boolean);

let resolvedApiBaseUrl: string | null = null;
let backendAvailable = false;
let probePromise: Promise<string | null> | null = null;
let probeFinished = false;

/**
 * Reads any user-configured proxy host from localStorage (`iptv_backend_proxy_url` or `iptv_proxy_settings_v1`)
 * if it looks like a full HTTP/HTTPS backend URL.
 */
export function getCustomConfiguredBackendUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    // 1. Check direct backend proxy URL setting
    const directUrl = window.localStorage.getItem('iptv_backend_proxy_url');
    if (directUrl && /^https?:\/\//i.test(directUrl.trim())) {
      return directUrl.trim().replace(/\/+$/, '');
    }

    // 2. Check structured proxy settings
    const raw = window.localStorage.getItem('iptv_proxy_settings_v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { enabled?: boolean; host?: string; port?: string };
    if (parsed?.enabled && parsed.host) {
      let h = parsed.host.trim();
      if (!/^https?:\/\//i.test(h)) {
        h = `http://${h}${parsed.port ? `:${parsed.port}` : ''}`;
      }
      return h.replace(/\/+$/, '');
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Detects if the current environment is a static-only host (like GitHub Pages, Vercel, Netlify,
 * or any host where `/api/probe` was checked and found not to be our Express server).
 */
export function isStaticHostEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  if (probeFinished && !backendAvailable) {
    return true;
  }
  const host = window.location.hostname.toLowerCase();
  const proto = window.location.protocol.toLowerCase();
  if (proto === 'file:' || proto === 'capacitor:' || proto === 'ionic:') {
    return true;
  }
  return (
    host.endsWith('.github.io') ||
    host.endsWith('.githubusercontent.com') ||
    host.endsWith('.pages.dev') ||
    host.endsWith('.netlify.app') ||
    host.endsWith('.vercel.app') ||
    host.endsWith('.surge.sh') ||
    host.endsWith('.gitlab.io') ||
    host.endsWith('.firebaseapp.com') ||
    host.endsWith('.web.app') ||
    host.endsWith('.render.com') ||
    host.endsWith('.onrender.com') ||
    host.endsWith('.fly.dev') ||
    host.endsWith('.railway.app') ||
    host.endsWith('.cloudflarepages.com')
  );
}

async function checkBackendUrl(baseUrl: string, timeoutMs = 2400): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Use /api/probe with empty query as a universal JSON health check (returns {"duration":null})
    const testUrl = `${baseUrl}/api/probe`;
    const res = await fetch(testUrl, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    // Static hosts (GitHub Pages / SPA hosts) return text/html for unknown routes
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
  if (probeFinished) {
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
    const customBackend = getCustomConfiguredBackendUrl();
    if (customBackend) {
      candidates.push(customBackend);
    }
    const envApiUrl = (
      (import.meta as unknown as { env?: Record<string, string> })?.env?.VITE_API_BASE_URL || ''
    )
      .trim()
      .replace(/\/+$/, '');
    if (envApiUrl && !candidates.includes(envApiUrl)) {
      candidates.push(envApiUrl);
    }
    for (const remoteUrl of REMOTE_BACKEND_FALLBACK_URLS) {
      if (remoteUrl && !candidates.includes(remoteUrl)) {
        candidates.push(remoteUrl);
      }
    }

    for (const candidate of candidates) {
      const ok = await checkBackendUrl(candidate, 1800);
      if (ok) {
        resolvedApiBaseUrl = candidate;
        backendAvailable = true;
        probeFinished = true;
        return candidate;
      }
    }

    // On static deployments (e.g. GitHub Pages), if no probe succeeded yet, default to first candidate
    // so proxy requests don't fall back to relative /api/proxy which 404s on static hosting.
    if (candidates.length > 0) {
      resolvedApiBaseUrl = candidates[0];
    } else {
      resolvedApiBaseUrl = null;
    }

    backendAvailable = resolvedApiBaseUrl !== null && resolvedApiBaseUrl !== '';
    probeFinished = true;
    return resolvedApiBaseUrl;
  })();

  return probePromise;
}

// Kick off background probe immediately on module load in browser
if (typeof window !== 'undefined') {
  ensureBackendProbed().catch(() => {});
}

/**
 * Synchronously returns the best known API base URL (`""` on full-stack host,
 * or custom/remote backend URL on static hosts).
 */
export function getEffectiveApiBaseUrl(): string {
  if (resolvedApiBaseUrl !== null) {
    return resolvedApiBaseUrl;
  }
  const customBackend = getCustomConfiguredBackendUrl();
  if (customBackend) {
    return customBackend;
  }
  const envApiUrl = (
    (import.meta as unknown as { env?: Record<string, string> })?.env?.VITE_API_BASE_URL || ''
  )
    .trim()
    .replace(/\/+$/, '');
  if (envApiUrl) {
    return envApiUrl;
  }
  for (const remoteUrl of REMOTE_BACKEND_FALLBACK_URLS) {
    if (remoteUrl) return remoteUrl;
  }
  return '';
}

/**
 * Returns whether the backend proxy/transcode server can be used.
 * Returns true if a backend URL is configured, detected, or available.
 */
export function canUseBackendProxy(): boolean {
  if (backendAvailable) return true;
  const base = getEffectiveApiBaseUrl();
  if (base && /^https?:\/\//i.test(base)) {
    return true;
  }
  if (probeFinished && isStaticHostEnvironment() && !base) return false;
  return !isStaticHostEnvironment();
}

/**
 * Detects whether a channel is a direct VOD URL (MP4, MKV, AVI, WebM, MOV, /movie/, /series/, /vod/, Pixeldrain, etc.)
 * that needs to be routed through the proxy server to avoid browser CORS and Mixed Content issues on GitHub Pages.
 */
export function isDirectVodChannel(
  channel:
    | Channel
    | {
        url?: string;
        group?: string;
        xtreamParams?: { streamType?: string };
        forceProxy?: boolean;
        isProxied?: boolean;
      }
): boolean {
  if (!channel || !channel.url) return false;
  if (channel.forceProxy || channel.isProxied) return true;

  const cleanUrl = channel.url.trim().toLowerCase();

  // If already proxied
  if (cleanUrl.includes('/api/proxy?') || cleanUrl.includes('api.cors.lol') || cleanUrl.includes('corsproxy.io')) {
    return true;
  }

  // Direct VOD media container extensions
  if (/\.(mp4|mkv|avi|webm|mov|m4v|flv|wmv|3gp|mpg|mpeg|divx|ogv)(\?|$|#|&)/i.test(cleanUrl)) {
    return true;
  }

  // Common IPTV VOD path segments
  if (/\/(movie|series|vod)\//i.test(cleanUrl)) {
    return true;
  }

  // VOD hosting services and cloud drives
  if (
    /pixeldrain\.(com|dev)|archive\.org|drive\.usercontent\.google\.com|drive\.google\.com|dropbox\.com|dropboxusercontent\.com|1fichier\.com|mega\.nz/i.test(
      cleanUrl
    )
  ) {
    return true;
  }

  // Xtream streamType
  if (channel.xtreamParams?.streamType === 'movie' || channel.xtreamParams?.streamType === 'series') {
    return true;
  }

  // Group name hint for VOD (e.g. "VOD Movies", "Series") unless it's an HLS live stream
  const group = (channel.group || '').toLowerCase();
  if (
    (group.includes('vod') ||
      group.includes('movie') ||
      group.includes('movies') ||
      group.includes('series') ||
      group.includes('cinema') ||
      group.includes('film')) &&
    !/\.m3u8(\?|$|#|&)/i.test(cleanUrl)
  ) {
    return true;
  }

  return false;
}

/**
 * Builds the proxy streaming URL for any channel.
 * Routes through the active backend / proxy server with authenticated query parameters.
 */
export function buildChannelProxyUrl(
  channel: Channel,
  fallbackUa?: string,
  overrideTargetUrl?: string,
  baseUrlOverride?: string
): string {
  const targetUrl = (overrideTargetUrl || channel.originalUrl || channel.url || '').trim();

  // If targetUrl is already a complete proxy URL, avoid double-wrapping
  if (targetUrl.includes('/api/proxy?')) {
    return targetUrl;
  }

  const base = baseUrlOverride !== undefined ? baseUrlOverride : getEffectiveApiBaseUrl();

  let qs = `url=${encodeURIComponent(targetUrl)}`;
  const effectiveUa = (channel.userAgent || fallbackUa || '').trim();
  if (effectiveUa) {
    qs += `&ua=${encodeURIComponent(effectiveUa)}`;
  }
  if (channel.referer) {
    qs += `&referer=${encodeURIComponent(channel.referer)}`;
  }
  if (channel.cookie) {
    qs += `&cookie=${encodeURIComponent(channel.cookie)}`;
  }
  if (channel.macAddress) {
    qs += `&mac=${encodeURIComponent(channel.macAddress)}`;
  }
  if (channel.authToken) {
    qs += `&auth=${encodeURIComponent(channel.authToken)}`;
  }
  if (channel.xtreamParams) {
    qs += `&xtreamServer=${encodeURIComponent(channel.xtreamParams.server)}`;
    qs += `&xtreamUser=${encodeURIComponent(channel.xtreamParams.username)}`;
    qs += `&xtreamPass=${encodeURIComponent(channel.xtreamParams.password)}`;
    qs += `&xtreamStreamId=${encodeURIComponent(channel.xtreamParams.streamId)}`;
    qs += `&xtreamType=${encodeURIComponent(channel.xtreamParams.streamType)}`;
  }
  if (channel.name) {
    qs += `&title=${encodeURIComponent(channel.name)}`;
  }

  return `${base}/api/proxy?${qs}`;
}

/**
 * Builds public CORS & HTTPS-bridge proxy URLs for fetching or streaming media/M3U/HLS/VOD
 * directly from the browser when deployed on GitHub Pages (HTTPS) or when backend proxy is unavailable.
 */
export function buildPublicCorsProxyUrls(targetUrl: string): string[] {
  if (!/^https?:\/\//i.test(targetUrl)) return [];
  return [
    `https://api.cors.lol/?url=${encodeURIComponent(targetUrl)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
    `https://cors.eu.org/${targetUrl}`,
  ];
}

/**
 * Given any media URL (HTTP or HTTPS), returns an ordered list of browser-safe URLs
 * that will not be blocked by Mixed Content on HTTPS GitHub Pages deployments.
 * When `forNativeVideo` is true, avoids text/buffer-only CORS proxies (cors.lol/codetabs/allorigins)
 * that buffer the entire video file before responding and cause `<video>` to hang on loading.
 */
export function getHttpsSafeMediaUrls(rawUrl: string, forNativeVideo = false): string[] {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return [];
  const urls: string[] = [];
  const pushUnique = (u?: string) => {
    if (u && !urls.includes(u)) urls.push(u);
  };

  const isPageHttps =
    typeof window !== 'undefined' && window.location.protocol === 'https:';
  const isTargetHttp = /^http:\/\//i.test(rawUrl);

  if (!isPageHttps || !isTargetHttp) {
    // Already HTTPS (or page is HTTP): <video> does not require CORS for native media playback
    pushUnique(rawUrl);
    if (!forNativeVideo) {
      for (const corsUrl of buildPublicCorsProxyUrls(rawUrl)) {
        pushUnique(corsUrl);
      }
    }
    return urls;
  }

  // Page is HTTPS (e.g. GitHub Pages) and target media URL is plain http://
  // 1. If target uses default port 80 (no explicit :8080/:25461), try direct https:// upgrade first (supports full Range seeking)
  if (/^http:\/\/[^/:]+(\/|$)/i.test(rawUrl)) {
    pushUnique(rawUrl.replace(/^http:\/\//i, 'https://'));
  }

  // 2. For HLS manifests / M3U8 text requests (forNativeVideo === false), bridge over public CORS proxies
  if (!forNativeVideo) {
    for (const corsUrl of buildPublicCorsProxyUrls(rawUrl)) {
      pushUnique(corsUrl);
    }
  }

  // 3. Keep rawUrl as fallback (browsers/WebViews allow passive mixed-content <video> or insecure content when enabled)
  pushUnique(rawUrl);

  return urls;
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

  // 1. If we are on a static host (like GitHub Pages), try Direct Fetch first for fast CORS-friendly HTTPS URLs
  if (isStaticHostEnvironment() && /^https:\/\//i.test(targetUrl)) {
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

  // 4. Try Public CORS Proxies (ensures GitHub Pages can load any HTTP/HTTPS M3U/Xtream/VOD URL)
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
