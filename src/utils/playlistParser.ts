export const DEFAULT_PLAYER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

export interface XtreamStreamParams {
  server: string;
  username: string;
  password: string;
  streamId: string;
  streamType: 'live' | 'movie' | 'series';
  extension?: string;
  queryParams?: string;
}

export interface Channel {
  id: string;
  name: string;
  url: string;
  group: string;
  logo?: string;
  tvgId?: string;
  userAgent?: string;
  referer?: string;
  cookie?: string;
  macAddress?: string;
  authToken?: string;
  xtreamParams?: XtreamStreamParams;
  number: number;
}

export interface Playlist {
  id: string;
  name: string;
  sourceUrl?: string;
  sourceType: 'url' | 'file' | 'sample';
  catchupType?: string;
  catchupDays?: string;
  channels: Channel[];
  addedAt: number;
}

export function isYouTubeChannelUrl(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  const u = rawUrl.trim();
  return (
    /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\b/i.test(u) ||
    /^vnd\.youtube:/i.test(u) ||
    /^youtube:\/\//i.test(u) ||
    /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//i.test(u)
  );
}

export function normalizeExternalRedirectUrl(rawUrl: string): string {
  const u = rawUrl.trim();
  if (/^vnd\.youtube:\/\/(www\.|m\.)?youtube\.com\//i.test(u)) {
    return u.replace(/^vnd\.youtube:\/\//i, 'https://');
  }
  if (/^vnd\.youtube:([a-zA-Z0-9_-]{11})/i.test(u)) {
    const match = u.match(/^vnd\.youtube:([a-zA-Z0-9_-]{11})/i);
    return `https://www.youtube.com/watch?v=${match?.[1] || ''}`;
  }
  if (/^youtube:\/\//i.test(u)) {
    return u.replace(/^youtube:\/\//i, 'https://www.youtube.com/');
  }
  if (!/^https?:\/\//i.test(u)) {
    return `https://${u}`;
  }
  return u;
}

export function openExternalChannelLink(rawUrl: string): void {
  const finalUrl = normalizeExternalRedirectUrl(rawUrl);
  const anchor = document.createElement('a');
  anchor.href = finalUrl;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function safeDecodeURIComponent(val: string): string {
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

/**
 * Normalizes a raw MAC address string (e.g. "00:1a:79:12:34:56", "00-1A-79-12-34-56",
 * "00%3A1A%3A79%3A12%3A34%3A56", or "001A79123456") into uppercase colon-separated format.
 */
export function normalizeMacAddress(rawMac?: string): string | undefined {
  if (!rawMac) return undefined;
  const decoded = safeDecodeURIComponent(safeDecodeURIComponent(rawMac))
    .trim()
    .replace(/^["']+|["']+$/g, '');
  const colonOrDashMatch = decoded.match(
    /\b([0-9a-fA-F]{2})(?:[:-]([0-9a-fA-F]{2})){5}\b/
  );
  if (colonOrDashMatch) {
    return colonOrDashMatch[0].replace(/-/g, ':').toUpperCase();
  }
  const underscoreMatch = decoded.match(
    /\b([0-9a-fA-F]{2})(?:_([0-9a-fA-F]{2})){5}\b/
  );
  if (underscoreMatch) {
    return underscoreMatch[0].replace(/_/g, ':').toUpperCase();
  }
  const compactHexMatch = decoded.match(/^[0-9a-fA-F]{12}$/);
  if (compactHexMatch) {
    return (
      decoded
        .toUpperCase()
        .match(/.{1,2}/g)
        ?.join(':') || undefined
    );
  }
  return undefined;
}

/**
 * Builds a standard Stalker / MAG STB cookie header for a given MAC address,
 * merging with any existing cookies without duplicating keys.
 */
export function buildMacCookieHeader(macAddress?: string, existingCookie?: string): string | undefined {
  const normMac = normalizeMacAddress(macAddress);
  if (!normMac && !existingCookie) return undefined;
  const parts: string[] = [];
  if (existingCookie) {
    existingCookie.split(';').forEach((c) => {
      const trimmed = c.trim();
      if (trimmed) parts.push(trimmed);
    });
  }
  if (normMac) {
    const hasMacInCookie = parts.some((p) => /^mac\s*=/i.test(p));
    if (!hasMacInCookie) {
      parts.unshift(`mac=${normMac}`);
    }
    if (!parts.some((p) => /^stb_lang\s*=/i.test(p))) {
      parts.push('stb_lang=en');
    }
    if (!parts.some((p) => /^timezone\s*=/i.test(p))) {
      parts.push('timezone=GMT');
    }
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

const RESERVED_NON_XTREAM_SEGMENTS = new Set([
  'live',
  'movie',
  'series',
  'play',
  'stalker_portal',
  'c',
  'server',
  'hls',
  'stream',
  'streams',
  'api',
  'download',
  'file',
  'details',
  'uc',
  'open',
  'vod',
  'tv',
  'channels',
  'ch',
  'portal.php',
  'load.php',
  'get.php',
  'player_api.php',
]);

/**
 * Parses Xtream Codes API stream URLs and MAC / Stalker Portal authentication parameters
 * from a stream URL.
 */
export function parseXtreamAndMacParams(rawUrl: string): {
  xtreamParams?: XtreamStreamParams;
  macAddress?: string;
  authToken?: string;
} {
  let u = rawUrl.trim();
  // Strip Stalker portal command prefixes like "ffmpeg http://..." or "ffrt3 http://..."
  u = u.replace(/^(?:ffmpeg|ffrt\d*|solution)\s+(?=(?:https?|rtmp|rtsp|udp|mms):\/\/)/i, '').trim();

  let xtreamParams: XtreamStreamParams | undefined;
  let macAddress: string | undefined;
  let authToken: string | undefined;

  // 1. Check for inline MAC address in URL query/path/params
  const macQueryMatch = u.match(
    /[?&;#|](?:mac|deviceMac|stb_mac|mac_address|hw_id)=([^&#|;\s]+)/i
  );
  if (macQueryMatch?.[1]) {
    macAddress = normalizeMacAddress(macQueryMatch[1]);
  }
  if (!macAddress) {
    const embeddedMacMatch = safeDecodeURIComponent(u).match(
      /\b(00:1[aA]:79:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2})\b/
    );
    if (embeddedMacMatch?.[1]) {
      macAddress = embeddedMacMatch[1].toUpperCase();
    }
  }

  // 2. Check for token / play_token / auth parameters in query string
  const tokenMatch = u.match(
    /[?&](?:play_token|token|access_token|auth_token|auth|jwt|wmsAuthSign)=([^&#|\s]+)/i
  );
  if (tokenMatch?.[1]) {
    authToken = safeDecodeURIComponent(tokenMatch[1]).trim();
  }

  // 3. Parse standard Xtream Codes API path:
  //    http(s)://host:port/(live|movie|series)/username/password/streamId(.ext)
  const explicitXtreamMatch = u.match(
    /^(https?:\/\/[^/?#]+)\/(live|movie|series)\/([^/?#]+)\/([^/?#]+)\/([^/?#.]+)(?:\.([a-zA-Z0-9]{2,5}))?(?:\?([^#]*))?$/i
  );
  if (explicitXtreamMatch) {
    const server = explicitXtreamMatch[1];
    const streamType = explicitXtreamMatch[2].toLowerCase() as 'live' | 'movie' | 'series';
    const username = safeDecodeURIComponent(explicitXtreamMatch[3]);
    const password = safeDecodeURIComponent(explicitXtreamMatch[4]);
    const streamId = explicitXtreamMatch[5];
    const extension = explicitXtreamMatch[6]?.toLowerCase();
    const queryParams = explicitXtreamMatch[7];
    xtreamParams = {
      server,
      username,
      password,
      streamId,
      streamType,
      extension,
      queryParams,
    };
    return { xtreamParams, macAddress, authToken };
  }

  // 4. Parse short Xtream Codes Live path:
  //    http(s)://host:port/username/password/streamId(.ext)
  const shortXtreamMatch = u.match(
    /^(https?:\/\/[^/?#]+)\/([^/?#]+)\/([^/?#]+)\/(\d+)(?:\.([a-zA-Z0-9]{2,5}))?(?:\?([^#]*))?$/i
  );
  if (shortXtreamMatch) {
    const seg1 = shortXtreamMatch[2].toLowerCase();
    const seg2 = shortXtreamMatch[3].toLowerCase();
    if (!RESERVED_NON_XTREAM_SEGMENTS.has(seg1) && !RESERVED_NON_XTREAM_SEGMENTS.has(seg2)) {
      xtreamParams = {
        server: shortXtreamMatch[1],
        username: safeDecodeURIComponent(shortXtreamMatch[2]),
        password: safeDecodeURIComponent(shortXtreamMatch[3]),
        streamId: shortXtreamMatch[4],
        streamType: 'live',
        extension: shortXtreamMatch[5]?.toLowerCase(),
        queryParams: shortXtreamMatch[6],
      };
      return { xtreamParams, macAddress, authToken };
    }
  }

  // 5. Parse query-based Xtream Codes URL:
  //    http(s)://host:port/live.php?username=...&password=...&stream=123&extension=ts
  try {
    const parsed = new URL(u);
    const qUser =
      parsed.searchParams.get('username') ||
      parsed.searchParams.get('user') ||
      parsed.searchParams.get('login');
    const qPass =
      parsed.searchParams.get('password') ||
      parsed.searchParams.get('pass');
    const qStream =
      parsed.searchParams.get('stream') ||
      parsed.searchParams.get('stream_id') ||
      parsed.searchParams.get('id') ||
      parsed.searchParams.get('ch_id');
    const qExt =
      parsed.searchParams.get('extension') ||
      parsed.searchParams.get('output') ||
      parsed.searchParams.get('type');

    if (qUser && qPass) {
      const pathStreamMatch = parsed.pathname.match(/\/(\d+)(?:\.([a-zA-Z0-9]{2,5}))?$/);
      const streamId = qStream || pathStreamMatch?.[1] || '';
      if (streamId) {
        const lowerPath = parsed.pathname.toLowerCase();
        const streamType: 'live' | 'movie' | 'series' = lowerPath.includes('movie')
          ? 'movie'
          : lowerPath.includes('series')
          ? 'series'
          : 'live';
        xtreamParams = {
          server: parsed.origin,
          username: qUser,
          password: qPass,
          streamId,
          streamType,
          extension: (qExt || pathStreamMatch?.[2] || undefined)?.toLowerCase(),
          queryParams: parsed.search ? parsed.search.slice(1) : undefined,
        };
      }
    }
  } catch {
    // ignore invalid URL
  }

  return { xtreamParams, macAddress, authToken };
}

/**
 * Generates alternate Xtream Codes stream URLs (e.g. .m3u8 and .ts variants with /live/ prefix)
 * so the player can seamlessly switch between HLS and MPEG-TS while preserving authentication.
 */
export function buildAuthenticatedXtreamAltUrls(channel: Channel): {
  hlsUrl?: string;
  tsUrl?: string;
  rawLiveUrl?: string;
} {
  const xp = channel.xtreamParams || parseXtreamAndMacParams(channel.url).xtreamParams;
  if (!xp || xp.streamType !== 'live') return {};
  const base = xp.server.replace(/\/+$/, '');
  const u = encodeURIComponent(xp.username);
  const p = encodeURIComponent(xp.password);
  const id = encodeURIComponent(xp.streamId);
  const qs = xp.queryParams ? `?${xp.queryParams}` : '';
  return {
    hlsUrl: `${base}/live/${u}/${p}/${id}.m3u8${qs}`,
    tsUrl: `${base}/live/${u}/${p}/${id}.ts${qs}`,
    rawLiveUrl: `${base}/live/${u}/${p}/${id}${qs}`,
  };
}

/**
 * Normalizes cloud VOD sharing links (Google Drive, Pixeldrain, Dropbox), Stalker cmd prefixes,
 * and cleans HTML artifacts or unencoded spaces.
 */
export function normalizeVodMediaUrl(rawUrl: string): string {
  let u = rawUrl
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");

  // Strip Stalker/MAG portal command prefixes like "ffmpeg http://..." or "ffrt3 http://..."
  u = u.replace(/^(?:ffmpeg|ffrt\d*|solution)\s+(?=(?:https?|rtmp|rtsp|udp|mms):\/\/)/i, '').trim();

  // Strip any HTML tags or quotes that might follow a URL in an HTML-wrapped M3U file
  u = u.split(/["'<>]/)[0].trim();

  // Fix accidental trailing HTML tag text from earlier parses (e.g. .mp4br, .mkv/p, etc.)
  u = u.replace(
    /\.(mp4|mkv|m3u8|ts|webm|avi|mov|m4v|flv|mp3|aac)(?:br|\/p|\/div|\/a|\/span|\/li|\/td|\/pre|\/body|\/html)+$/i,
    '.$1'
  );

  if (u.startsWith('//')) {
    u = `https:${u}`;
  }

  // Google Drive: /file/d/<ID>/view or /open?id=<ID> or /uc?id=<ID>
  const gdriveFileMatch = u.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i);
  const gdriveIdMatch = u.match(/drive\.google\.com\/(?:open|uc)\?[^#]*\bid=([a-zA-Z0-9_-]+)/i);
  const gdriveId = gdriveFileMatch?.[1] || gdriveIdMatch?.[1];
  if (gdriveId) {
    return `https://drive.usercontent.google.com/download?id=${gdriveId}&export=download&confirm=t`;
  }

  // Pixeldrain: https://pixeldrain.com/u/<ID> -> https://pixeldrain.com/api/file/<ID>
  const pixeldrainMatch = u.match(/pixeldrain\.com\/u\/([a-zA-Z0-9_-]+)/i);
  if (pixeldrainMatch?.[1]) {
    return `https://pixeldrain.com/api/file/${pixeldrainMatch[1]}`;
  }

  // Dropbox: https://www.dropbox.com/... -> https://dl.dropboxusercontent.com/...
  if (/^https?:\/\/(?:www\.)?dropbox\.com\//i.test(u)) {
    u = u
      .replace(/^https?:\/\/(?:www\.)?dropbox\.com\//i, 'https://dl.dropboxusercontent.com/')
      .replace(/[?&]dl=0\b/i, '');
  }

  return u.replace(/ /g, '%20');
}

/**
 * Extracts pipe headers like `http://...|User-Agent=foo&Referer=bar&Cookie=mac=00:1A:79:...&Authorization=Bearer ...`
 * as well as Xtream Codes API parameters and MAC address parameters.
 */
export function extractUrlAndPipeHeaders(rawUrl: string): {
  url: string;
  userAgent?: string;
  referer?: string;
  cookie?: string;
  macAddress?: string;
  authToken?: string;
  xtreamParams?: XtreamStreamParams;
} {
  const cleanedRaw = rawUrl
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&');

  const pipeIndex = cleanedRaw.indexOf('|');
  const basePart = pipeIndex === -1 ? cleanedRaw : cleanedRaw.slice(0, pipeIndex);
  const base = normalizeVodMediaUrl(basePart);
  const parsedUrlAuth = parseXtreamAndMacParams(base);

  let userAgent: string | undefined;
  let referer: string | undefined;
  let cookie: string | undefined;
  let macAddress: string | undefined = parsedUrlAuth.macAddress;
  let authToken: string | undefined = parsedUrlAuth.authToken;

  if (pipeIndex !== -1) {
    const headerPart = cleanedRaw.slice(pipeIndex + 1).trim();
    headerPart.split(/[&|]/).forEach((pair) => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx !== -1) {
        const key = pair.slice(0, eqIdx).trim().toLowerCase();
        const rawVal = pair
          .slice(eqIdx + 1)
          .trim()
          .replace(/^["']+|["']+$/g, '');
        const val = safeDecodeURIComponent(rawVal);
        if (key === 'user-agent' || key === 'useragent' || key === 'http-user-agent') {
          userAgent = val;
        } else if (
          key === 'referer' ||
          key === 'referrer' ||
          key === 'origin' ||
          key === 'http-referer' ||
          key === 'http-referrer'
        ) {
          referer = val;
        } else if (key === 'cookie' || key === 'cookies' || key === 'http-cookie') {
          cookie = cookie ? `${cookie}; ${val}` : val;
          const macInCookie = normalizeMacAddress(val);
          if (macInCookie && !macAddress) {
            macAddress = macInCookie;
          }
        } else if (
          key === 'mac' ||
          key === 'mac-address' ||
          key === 'mac_address' ||
          key === 'stb-mac' ||
          key === 'stb_mac' ||
          key === 'devicemac'
        ) {
          const norm = normalizeMacAddress(val);
          if (norm) macAddress = norm;
        } else if (
          key === 'authorization' ||
          key === 'auth' ||
          key === 'token' ||
          key === 'play_token' ||
          key === 'bearer' ||
          key === 'x-auth-token'
        ) {
          authToken = val;
        }
      }
    });
  }

  const finalCookie = buildMacCookieHeader(macAddress, cookie);

  return {
    url: base,
    userAgent,
    referer,
    cookie: finalCookie,
    macAddress,
    authToken,
    xtreamParams: parsedUrlAuth.xtreamParams,
  };
}

/**
 * Repairs and normalizes an existing Channel (e.g. loaded from localStorage),
 * ensuring Xtream Codes API parameters and MAC address auth parameters are extracted.
 */
export function repairAndNormalizeChannel(ch: Channel): Channel {
  const extracted = extractUrlAndPipeHeaders(ch.url || '');
  const resolvedMac =
    normalizeMacAddress(ch.macAddress) ||
    extracted.macAddress ||
    normalizeMacAddress(ch.cookie);
  const resolvedCookie = buildMacCookieHeader(resolvedMac, ch.cookie || extracted.cookie);
  return {
    ...ch,
    url: extracted.url,
    userAgent: ch.userAgent || extracted.userAgent,
    referer: ch.referer || extracted.referer,
    cookie: resolvedCookie,
    macAddress: resolvedMac,
    authToken: ch.authToken || extracted.authToken,
    xtreamParams: ch.xtreamParams || extracted.xtreamParams,
  };
}

/**
 * Parses M3U / M3U8 playlist content into a list of channels.
 */
export function parseM3U(content: string): Channel[] {
  // Pre-normalize HTML line-break tags and entities in case an M3U playlist is wrapped in index.html
  const normalizedContent = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|pre)>/gi, '\n')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&');

  const lines = normalizedContent.split(/\r?\n/);
  const channels: Channel[] = [];

  let currentName = '';
  let currentGroup = 'All channels';
  let currentLogo = '';
  let currentTvgId = '';
  let currentUserAgent: string | undefined;
  let currentReferer: string | undefined;
  let currentCookie: string | undefined;
  let currentMacAddress: string | undefined;
  let currentAuthToken: string | undefined;

  const pushChannelFromRawUrl = (rawLine: string) => {
    const firstQuoteOrTag = rawLine.split(/["'<>]/)[0].trim();
    if (!firstQuoteOrTag) return;
    const {
      url,
      userAgent,
      referer,
      cookie,
      macAddress,
      authToken,
      xtreamParams,
    } = extractUrlAndPipeHeaders(firstQuoteOrTag);
    if (!url) return;
    const number = channels.length + 1;
    const finalMac = macAddress || currentMacAddress;
    const finalCookie = buildMacCookieHeader(finalMac, cookie || currentCookie);
    channels.push({
      id: `ch-${number}-${Math.random().toString(36).slice(2, 7)}`,
      name: currentName || `Channel ${number}`,
      url,
      group: currentGroup || 'General',
      logo: currentLogo || undefined,
      tvgId: currentTvgId || undefined,
      userAgent: userAgent || currentUserAgent,
      referer: referer || currentReferer,
      cookie: finalCookie,
      macAddress: finalMac,
      authToken: authToken || currentAuthToken,
      xtreamParams,
      number,
    });
    currentName = '';
    currentGroup = 'General';
    currentLogo = '';
    currentTvgId = '';
    currentUserAgent = undefined;
    currentReferer = undefined;
    currentCookie = undefined;
    currentMacAddress = undefined;
    currentAuthToken = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.includes('#EXTINF:')) {
      const extInfLine = line.slice(line.indexOf('#EXTINF:'));

      const logoMatch = extInfLine.match(/tvg-logo=["']([^"']*)["']/i);
      const groupMatch = extInfLine.match(/group-title=["']([^"']*)["']/i);
      const tvgIdMatch = extInfLine.match(/tvg-id=["']([^"']*)["']/i);
      const tvgNameMatch = extInfLine.match(/tvg-name=["']([^"']*)["']/i);
      const uaAttrMatch = extInfLine.match(/(?:user-agent|http-user-agent)=["']([^"']*)["']/i);
      const refAttrMatch = extInfLine.match(/(?:referer|referrer|http-referer|http-referrer)=["']([^"']*)["']/i);
      const macAttrMatch = extInfLine.match(/(?:tvg-mac|mac|mac-address|stb-mac)=["']([^"']*)["']/i);
      const cookieAttrMatch = extInfLine.match(/(?:cookie|http-cookie)=["']([^"']*)["']/i);
      const tokenAttrMatch = extInfLine.match(/(?:token|play-token|play_token|authorization)=["']([^"']*)["']/i);

      currentLogo = logoMatch ? logoMatch[1].trim() : '';
      currentGroup = groupMatch && groupMatch[1].trim() ? groupMatch[1].trim() : 'General';
      currentTvgId = tvgIdMatch ? tvgIdMatch[1].trim() : '';
      if (uaAttrMatch?.[1]) currentUserAgent = uaAttrMatch[1].trim();
      if (refAttrMatch?.[1]) currentReferer = refAttrMatch[1].trim();
      if (macAttrMatch?.[1]) currentMacAddress = normalizeMacAddress(macAttrMatch[1].trim());
      if (cookieAttrMatch?.[1]) currentCookie = cookieAttrMatch[1].trim();
      if (tokenAttrMatch?.[1]) currentAuthToken = tokenAttrMatch[1].trim();

      // Strip any quotes/attributes first to find the comma separating metadata from channel title
      const commaIndex = extInfLine.lastIndexOf(',');
      if (commaIndex !== -1) {
        const afterComma = extInfLine.slice(commaIndex + 1).trim();
        // Check if URL was placed on the same line right after the channel title
        const inlineUrlMatch = afterComma.match(
          /\s+((?:ffmpeg\s+|ffrt\d*\s+)?(?:https?:\/\/|rtmp:\/\/|rtsp:\/\/|udp:\/\/|mms:\/\/|vnd\.youtube:|youtube:\/\/))(.+)$/i
        );
        if (inlineUrlMatch && inlineUrlMatch.index !== undefined) {
          currentName = afterComma
            .slice(0, inlineUrlMatch.index)
            .replace(/<[^>]*>/g, '')
            .trim();
          pushChannelFromRawUrl(inlineUrlMatch[1] + inlineUrlMatch[2]);
        } else {
          currentName = afterComma.replace(/<[^>]*>/g, '').trim();
        }
      } else if (tvgNameMatch) {
        currentName = tvgNameMatch[1].trim();
      } else {
        currentName = `Channel ${channels.length + 1}`;
      }
    } else if (line.startsWith('#EXTGRP:')) {
      const grp = line.replace('#EXTGRP:', '').trim();
      if (grp) currentGroup = grp;
    } else if (line.toLowerCase().startsWith('#extvlcopt:')) {
      const opt = line.slice(11).trim();
      const lowerOpt = opt.toLowerCase();
      if (lowerOpt.startsWith('http-user-agent=')) {
        currentUserAgent = opt.slice(16).trim();
      } else if (lowerOpt.startsWith('http-referrer=')) {
        currentReferer = opt.slice(14).trim();
      } else if (lowerOpt.startsWith('http-referer=')) {
        currentReferer = opt.slice(13).trim();
      } else if (lowerOpt.startsWith('http-cookie=')) {
        currentCookie = opt.slice(12).trim();
        const mac = normalizeMacAddress(currentCookie);
        if (mac) currentMacAddress = mac;
      } else if (lowerOpt.startsWith('http-mac=') || lowerOpt.startsWith('mac=')) {
        const eqIdx = opt.indexOf('=');
        currentMacAddress = normalizeMacAddress(opt.slice(eqIdx + 1).trim());
      } else if (lowerOpt.startsWith('http-header=')) {
        const hdr = opt.slice(12).trim();
        if (/^authorization\s*:/i.test(hdr)) {
          currentAuthToken = hdr.replace(/^authorization\s*:\s*/i, '').trim();
        } else if (/^cookie\s*:/i.test(hdr)) {
          currentCookie = hdr.replace(/^cookie\s*:\s*/i, '').trim();
          const mac = normalizeMacAddress(currentCookie);
          if (mac) currentMacAddress = mac;
        }
      }
    } else if (line.toLowerCase().startsWith('#kodiprop:')) {
      const prop = line.slice(10).trim();
      const eqIdx = prop.indexOf('=');
      if (eqIdx !== -1) {
        const val = prop.slice(eqIdx + 1).trim();
        const extracted = extractUrlAndPipeHeaders(`http://dummy|${val}`);
        if (extracted.userAgent) currentUserAgent = extracted.userAgent;
        if (extracted.referer) currentReferer = extracted.referer;
        if (extracted.cookie) currentCookie = extracted.cookie;
        if (extracted.macAddress) currentMacAddress = extracted.macAddress;
        if (extracted.authToken) currentAuthToken = extracted.authToken;
      }
    } else if (line.toLowerCase().startsWith('#exthttp:')) {
      try {
        const jsonStr = line.slice(9).trim();
        const parsed = JSON.parse(jsonStr) as Record<string, string>;
        const ua = parsed['User-Agent'] || parsed['user-agent'] || parsed['UserAgent'];
        const ref = parsed['Referer'] || parsed['referer'] || parsed['Origin'] || parsed['origin'];
        const ck = parsed['Cookie'] || parsed['cookie'];
        const mac = parsed['mac'] || parsed['MAC'] || parsed['X-MAC'];
        const auth = parsed['Authorization'] || parsed['authorization'] || parsed['token'];
        if (ua) currentUserAgent = String(ua);
        if (ref) currentReferer = String(ref);
        if (ck) currentCookie = String(ck);
        if (mac) currentMacAddress = normalizeMacAddress(String(mac));
        if (auth) currentAuthToken = String(auth);
      } catch {
        // ignore invalid JSON
      }
    } else if (!line.startsWith('#')) {
      const urlStartMatch = line.match(
        /((?:ffmpeg\s+|ffrt\d*\s+)?(?:https?:\/\/|rtmp:\/\/|rtsp:\/\/|udp:\/\/|mms:\/\/|vnd\.youtube:|youtube:\/\/)).*/i
      );
      if (urlStartMatch) {
        pushChannelFromRawUrl(urlStartMatch[0]);
      }
    }
  }

  return channels;
}

/**
 * Parses XSPF (XML Shareable Playlist Format) content into a list of channels.
 */
export function parseXSPF(content: string): Channel[] {
  const channels: Channel[] = [];
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(content, 'text/xml');
    const tracks = xmlDoc.getElementsByTagName('track');

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const locationNode = track.getElementsByTagName('location')[0];
      const titleNode = track.getElementsByTagName('title')[0];
      const creatorNode = track.getElementsByTagName('creator')[0];
      const albumNode = track.getElementsByTagName('album')[0];
      const imageNode = track.getElementsByTagName('image')[0];

      const rawUrl = locationNode?.textContent?.trim() || '';
      if (!rawUrl) continue;

      const {
        url,
        userAgent,
        referer,
        cookie,
        macAddress,
        authToken,
        xtreamParams,
      } = extractUrlAndPipeHeaders(rawUrl);
      const number = channels.length + 1;
      const name = titleNode?.textContent?.trim() || `Channel ${number}`;
      const group = albumNode?.textContent?.trim() || creatorNode?.textContent?.trim() || 'General';
      const logo = imageNode?.textContent?.trim() || undefined;

      channels.push({
        id: `xspf-${number}-${Math.random().toString(36).slice(2, 7)}`,
        name,
        url,
        group,
        logo,
        userAgent,
        referer,
        cookie,
        macAddress,
        authToken,
        xtreamParams,
        number,
      });
    }
  } catch (err) {
    console.error('Failed to parse XSPF playlist:', err);
  }
  return channels;
}

/**
 * Parses HTML files (e.g. index.html IPTV channel portals) if they don't use raw #EXTINF.
 */
export function parseHTMLPlaylist(content: string): Channel[] {
  if (content.includes('#EXTINF:')) {
    const m3uChannels = parseM3U(content);
    if (m3uChannels.length > 0) return m3uChannels;
  }

  const channels: Channel[] = [];
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/html');

    const candidates = doc.querySelectorAll(
      'a, [data-url], [data-stream], [data-src], [data-href], [data-link], [data-video], [onclick], .channel, .card, .item'
    );
    candidates.forEach((el) => {
      const img = el.querySelector('img');
      const logo = img?.getAttribute('src') || img?.getAttribute('data-src') || undefined;
      const rawText = el.textContent?.trim() || img?.getAttribute('alt')?.trim() || '';
      const href =
        el.getAttribute('href') ||
        el.getAttribute('data-url') ||
        el.getAttribute('data-stream') ||
        el.getAttribute('data-src') ||
        el.getAttribute('data-href') ||
        el.getAttribute('data-link') ||
        el.getAttribute('data-video') ||
        el.querySelector('a')?.getAttribute('href') ||
        el.querySelector('source')?.getAttribute('src') ||
        '';
      const onclick =
        el.getAttribute('onclick') ||
        el.querySelector('[onclick]')?.getAttribute('onclick') ||
        '';
      const quotedUrlMatch = onclick.match(/['"](https?:\/\/[^'"]+)['"]/i);
      const unquotedUrlMatch = onclick.match(/(https?:\/\/[^'")\s]+)/i);
      const streamUrl =
        href && !href.startsWith('#') && !href.startsWith('javascript:')
          ? href
          : quotedUrlMatch
          ? quotedUrlMatch[1]
          : unquotedUrlMatch
          ? unquotedUrlMatch[1]
          : '';

      if (rawText && (streamUrl || logo)) {
        const {
          url,
          userAgent,
          referer,
          cookie,
          macAddress,
          authToken,
          xtreamParams,
        } = extractUrlAndPipeHeaders(
          streamUrl || 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
        );
        const attrMac = normalizeMacAddress(
          el.getAttribute('data-mac') || el.getAttribute('mac') || undefined
        );
        const finalMac = macAddress || attrMac;
        const finalCookie = buildMacCookieHeader(finalMac, cookie);
        const number = channels.length + 1;
        channels.push({
          id: `html-${number}-${Math.random().toString(36).slice(2, 7)}`,
          name: rawText.replace(/\s+/g, ' ').slice(0, 60),
          url,
          group: el.getAttribute('data-group') || el.getAttribute('data-category') || 'General',
          logo,
          userAgent,
          referer,
          cookie: finalCookie,
          macAddress: finalMac,
          authToken,
          xtreamParams,
          number,
        });
      }
    });

    // If no DOM elements matched, check <script> tags for embedded channel objects or stream URLs
    if (channels.length === 0) {
      const scripts = Array.from(doc.querySelectorAll('script'))
        .map((s) => s.textContent || '')
        .join('\n');
      const objRegex =
        /\{[^{}]*?(?:name|title)\s*:\s*["']([^"']+)["'][^{}]*?(?:url|src|file|stream|link)\s*:\s*["'](https?:\/\/[^"']+)["'][^{}]*?\}/gi;
      let match: RegExpExecArray | null;
      while ((match = objRegex.exec(scripts)) !== null) {
        const {
          url,
          userAgent,
          referer,
          cookie,
          macAddress,
          authToken,
          xtreamParams,
        } = extractUrlAndPipeHeaders(match[2]);
        const number = channels.length + 1;
        channels.push({
          id: `html-js-${number}-${Math.random().toString(36).slice(2, 7)}`,
          name: match[1].trim(),
          url,
          group: 'General',
          userAgent,
          referer,
          cookie,
          macAddress,
          authToken,
          xtreamParams,
          number,
        });
      }
    }
  } catch (err) {
    console.error('Failed to parse HTML playlist:', err);
  }

  if (channels.length === 0) {
    return parseM3U(content);
  }

  return channels;
}

/**
 * Automatically detects whether content is M3U, XSPF, JSON, or HTML and parses it.
 */
export function parsePlaylistContent(content: string): Channel[] {
  const trimmed = content.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];

  if (trimmed.includes('#EXTINF:')) {
    const m3u = parseM3U(trimmed);
    if (m3u.length > 0) return m3u;
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsedJson = JSON.parse(trimmed);
      const arr = Array.isArray(parsedJson)
        ? parsedJson
        : Array.isArray(parsedJson?.channels)
        ? parsedJson.channels
        : Array.isArray(parsedJson?.js?.data)
        ? parsedJson.js.data
        : Array.isArray(parsedJson?.playlists?.[0]?.channels)
        ? parsedJson.playlists[0].channels
        : null;
      if (arr && arr.length > 0) {
        const jsonChannels: Channel[] = [];
        arr.forEach((item: Record<string, unknown>, idx: number) => {
          const rawUrl = String(
            item.url || item.stream || item.src || item.file || item.link || item.cmd || ''
          ).trim();
          if (!rawUrl) return;
          const {
            url,
            userAgent,
            referer,
            cookie,
            macAddress,
            authToken,
            xtreamParams,
          } = extractUrlAndPipeHeaders(rawUrl);
          const itemMac = normalizeMacAddress(
            String(item.mac || item.macAddress || item.stb_mac || '')
          );
          const finalMac = macAddress || itemMac;
          const finalCookie = buildMacCookieHeader(
            finalMac,
            (item.cookie as string) || cookie
          );
          jsonChannels.push({
            id: String(item.id || `json-${idx + 1}-${Math.random().toString(36).slice(2, 7)}`),
            name: String(item.name || item.title || `Channel ${idx + 1}`).trim(),
            url,
            group: String(item.group || item.category || 'General').trim(),
            logo: item.logo ? String(item.logo) : undefined,
            userAgent: (item.userAgent as string) || userAgent,
            referer: (item.referer as string) || referer,
            cookie: finalCookie,
            macAddress: finalMac,
            authToken: (item.authToken as string) || (item.token as string) || authToken,
            xtreamParams: (item.xtreamParams as XtreamStreamParams) || xtreamParams,
            number: idx + 1,
          });
        });
        if (jsonChannels.length > 0) return jsonChannels;
      }
    } catch {
      // Fall through to other parsers
    }
  }

  if (trimmed.startsWith('<?xml') || trimmed.includes('<playlist') || trimmed.includes('<trackList>')) {
    const xspf = parseXSPF(trimmed);
    if (xspf.length > 0) return xspf;
  }
  if (trimmed.includes('<html') || trimmed.includes('<!DOCTYPE') || trimmed.includes('<div') || trimmed.includes('<a ')) {
    const htmlCh = parseHTMLPlaylist(trimmed);
    if (htmlCh.length > 0) return htmlCh;
  }
  return parseM3U(trimmed);
}

/**
 * Built-in verified public HLS streams for testing IPTV playback immediately.
 */
export const SAMPLE_M3U_CONTENT = `#EXTM3U
#EXTINF:-1 tvg-id="NASA" group-title="Science & Space",NASA TV Public
https://ntv1.akamaized.net/hls/live/2014075/NASA-NTV1-HLS/master.m3u8
#EXTINF:-1 tvg-id="DWEnglish" group-title="News",DW English Live
https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/index.m3u8
#EXTINF:-1 tvg-id="AlJazeera" group-title="News",Al Jazeera English
https://live-hls-web-aje.getaj.net/AJE/index.m3u8
#EXTINF:-1 tvg-id="France24" group-title="News",France 24 English
https://f24hls-i.akamaihd.net/hls/live/221147/F24_EN_HI_HLS/master_2000.m3u8
#EXTINF:-1 tvg-id="RedBullTV" group-title="Sports",Red Bull TV
https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8
#EXTINF:-1 tvg-id="BigBuckBunny" group-title="Movies & Animation",Big Buck Bunny HD (Test Stream)
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
#EXTINF:-1 tvg-id="Sintel" group-title="Movies & Animation",Sintel Open Movie 4K
https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8
#EXTINF:-1 tvg-id="TearsOfSteel" group-title="Movies & Animation",Tears of Steel Sci-Fi
https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8
#EXTINF:-1 tvg-id="AppleAdvanced" group-title="Tech & Demo",Apple BipBop Multivariant HLS
https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8
`;

export const PRESET_PLAYLIST_URLS = [
  {
    name: 'IPTV-Org India Channels (M3U)',
    url: 'https://iptv-org.github.io/iptv/countries/in.m3u',
  },
  {
    name: 'IPTV-Org Hindi Channels (M3U)',
    url: 'https://iptv-org.github.io/iptv/languages/hin.m3u',
  },
  {
    name: 'IPTV-Org News Channels (M3U)',
    url: 'https://iptv-org.github.io/iptv/categories/news.m3u',
  },
  {
    name: 'IPTV-Org Sports Channels (M3U)',
    url: 'https://iptv-org.github.io/iptv/categories/sports.m3u',
  },
];
