export interface Channel {
  id: string;
  name: string;
  url: string;
  group: string;
  logo?: string;
  tvgId?: string;
  userAgent?: string;
  referer?: string;
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

/**
 * Normalizes cloud VOD sharing links (Google Drive, Pixeldrain, Dropbox) into direct media stream URLs
 * and cleans HTML artifacts or unencoded spaces.
 */
export function normalizeVodMediaUrl(rawUrl: string): string {
  let u = rawUrl
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");

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

function safeDecodeURIComponent(val: string): string {
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

/**
 * Extracts pipe headers like `http://...|User-Agent=foo&Referer=bar` or `http://...|User-Agent=foo|Referer=bar`
 * and encodes raw spaces inside the URL path as %20 so VOD URLs with spaces play properly.
 */
export function extractUrlAndPipeHeaders(rawUrl: string): {
  url: string;
  userAgent?: string;
  referer?: string;
} {
  const cleanedRaw = rawUrl
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&');

  const pipeIndex = cleanedRaw.indexOf('|');
  if (pipeIndex === -1) {
    return { url: normalizeVodMediaUrl(cleanedRaw) };
  }

  const base = normalizeVodMediaUrl(cleanedRaw.slice(0, pipeIndex));
  const headerPart = cleanedRaw.slice(pipeIndex + 1).trim();
  let userAgent: string | undefined;
  let referer: string | undefined;

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
      }
    }
  });

  return { url: base, userAgent, referer };
}

/**
 * Repairs and normalizes an existing Channel (e.g. loaded from localStorage).
 */
export function repairAndNormalizeChannel(ch: Channel): Channel {
  const extracted = extractUrlAndPipeHeaders(ch.url || '');
  return {
    ...ch,
    url: extracted.url,
    userAgent: ch.userAgent || extracted.userAgent,
    referer: ch.referer || extracted.referer,
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

  const pushChannelFromRawUrl = (rawLine: string) => {
    const firstQuoteOrTag = rawLine.split(/["'<>]/)[0].trim();
    if (!firstQuoteOrTag) return;
    const { url, userAgent, referer } = extractUrlAndPipeHeaders(firstQuoteOrTag);
    if (!url) return;
    const number = channels.length + 1;
    channels.push({
      id: `ch-${number}-${Math.random().toString(36).slice(2, 7)}`,
      name: currentName || `Channel ${number}`,
      url,
      group: currentGroup || 'General',
      logo: currentLogo || undefined,
      tvgId: currentTvgId || undefined,
      userAgent: userAgent || currentUserAgent,
      referer: referer || currentReferer,
      number,
    });
    currentName = '';
    currentGroup = 'General';
    currentLogo = '';
    currentTvgId = '';
    currentUserAgent = undefined;
    currentReferer = undefined;
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

      currentLogo = logoMatch ? logoMatch[1].trim() : '';
      currentGroup = groupMatch && groupMatch[1].trim() ? groupMatch[1].trim() : 'General';
      currentTvgId = tvgIdMatch ? tvgIdMatch[1].trim() : '';
      if (uaAttrMatch?.[1]) currentUserAgent = uaAttrMatch[1].trim();
      if (refAttrMatch?.[1]) currentReferer = refAttrMatch[1].trim();

      // Strip any quotes/attributes first to find the comma separating metadata from channel title
      const commaIndex = extInfLine.lastIndexOf(',');
      if (commaIndex !== -1) {
        const afterComma = extInfLine.slice(commaIndex + 1).trim();
        // Check if URL was placed on the same line right after the channel title
        const inlineUrlMatch = afterComma.match(
          /\s+(https?:\/\/|rtmp:\/\/|rtsp:\/\/|udp:\/\/|mms:\/\/|vnd\.youtube:|youtube:\/\/)(.+)$/i
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
      if (opt.toLowerCase().startsWith('http-user-agent=')) {
        currentUserAgent = opt.slice(16).trim();
      } else if (opt.toLowerCase().startsWith('http-referrer=')) {
        currentReferer = opt.slice(14).trim();
      } else if (opt.toLowerCase().startsWith('http-referer=')) {
        currentReferer = opt.slice(13).trim();
      }
    } else if (line.toLowerCase().startsWith('#kodiprop:')) {
      const prop = line.slice(10).trim();
      const eqIdx = prop.indexOf('=');
      if (eqIdx !== -1) {
        const val = prop.slice(eqIdx + 1).trim();
        const extracted = extractUrlAndPipeHeaders(`http://dummy|${val}`);
        if (extracted.userAgent) currentUserAgent = extracted.userAgent;
        if (extracted.referer) currentReferer = extracted.referer;
      }
    } else if (line.toLowerCase().startsWith('#exthttp:')) {
      try {
        const jsonStr = line.slice(9).trim();
        const parsed = JSON.parse(jsonStr) as Record<string, string>;
        const ua = parsed['User-Agent'] || parsed['user-agent'] || parsed['UserAgent'];
        const ref = parsed['Referer'] || parsed['referer'] || parsed['Origin'] || parsed['origin'];
        if (ua) currentUserAgent = String(ua);
        if (ref) currentReferer = String(ref);
      } catch {
        // ignore invalid JSON
      }
    } else if (!line.startsWith('#')) {
      const urlStartMatch = line.match(
        /(https?:\/\/|rtmp:\/\/|rtsp:\/\/|udp:\/\/|mms:\/\/|vnd\.youtube:|youtube:\/\/).*/i
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

      const { url, userAgent, referer } = extractUrlAndPipeHeaders(rawUrl);
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
        const { url, userAgent, referer } = extractUrlAndPipeHeaders(
          streamUrl || 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
        );
        const number = channels.length + 1;
        channels.push({
          id: `html-${number}-${Math.random().toString(36).slice(2, 7)}`,
          name: rawText.replace(/\s+/g, ' ').slice(0, 60),
          url,
          group: el.getAttribute('data-group') || el.getAttribute('data-category') || 'General',
          logo,
          userAgent,
          referer,
          number,
        });
      }
    });
  } catch (err) {
    console.error('Failed to parse HTML playlist:', err);
  }

  return channels;
}

/**
 * Automatically detects whether content is M3U, XSPF, or HTML and parses it.
 */
export function parsePlaylistContent(content: string): Channel[] {
  const trimmed = content.trim();
  if (trimmed.includes('#EXTINF:')) {
    const m3u = parseM3U(trimmed);
    if (m3u.length > 0) return m3u;
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
