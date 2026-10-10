import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import http from 'http';
import https from 'https';
import { spawn } from 'child_process';

// Allow IPTV and VOD servers that use self-signed or incomplete SSL certificate chains
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const DEFAULT_BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';
const VLC_UA = 'VLC/3.0.20 LibVLC/3.0.20';
const LAVF_UA = 'Lavf/60.16.100';

function sanitizeAndNormalizeUrl(rawUrl: string): {
  url: string;
  pipeUa?: string;
  pipeReferer?: string;
} {
  let cleaned = rawUrl
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");

  let pipeUa: string | undefined;
  let pipeReferer: string | undefined;

  const pipeIdx = cleaned.indexOf('|');
  if (pipeIdx !== -1) {
    const headerPart = cleaned.slice(pipeIdx + 1).trim();
    cleaned = cleaned.slice(0, pipeIdx).trim();
    headerPart.split(/[&|]/).forEach((pair) => {
      const eq = pair.indexOf('=');
      if (eq !== -1) {
        const k = pair.slice(0, eq).trim().toLowerCase();
        const rawV = pair
          .slice(eq + 1)
          .trim()
          .replace(/^["']+|["']+$/g, '');
        let v = rawV;
        try {
          v = decodeURIComponent(rawV);
        } catch {
          // keep rawV
        }
        if (k === 'user-agent' || k === 'useragent' || k === 'http-user-agent') {
          pipeUa = v;
        } else if (
          k === 'referer' ||
          k === 'referrer' ||
          k === 'origin' ||
          k === 'http-referer' ||
          k === 'http-referrer'
        ) {
          pipeReferer = v;
        }
      }
    });
  }

  cleaned = cleaned.split(/["'<>]/)[0].trim();
  cleaned = cleaned.replace(
    /\.(mp4|mkv|m3u8|ts|webm|avi|mov|m4v|flv|mp3|aac)(?:br|\/p|\/div|\/a|\/span|\/li|\/td|\/pre|\/body|\/html)+$/i,
    '.$1'
  );

  if (cleaned.startsWith('//')) {
    cleaned = `https:${cleaned}`;
  }

  // Google Drive direct download conversion
  const gdriveFileMatch = cleaned.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i);
  const gdriveIdMatch = cleaned.match(
    /drive\.google\.com\/(?:open|uc)\?[^#]*\bid=([a-zA-Z0-9_-]+)/i
  );
  const gdriveId = gdriveFileMatch?.[1] || gdriveIdMatch?.[1];
  if (gdriveId) {
    cleaned = `https://drive.usercontent.google.com/download?id=${gdriveId}&export=download&confirm=t`;
  }

  // Pixeldrain conversion
  const pixeldrainMatch = cleaned.match(/pixeldrain\.com\/u\/([a-zA-Z0-9_-]+)/i);
  if (pixeldrainMatch?.[1]) {
    cleaned = `https://pixeldrain.com/api/file/${pixeldrainMatch[1]}`;
  }

  // Dropbox conversion
  if (/^https?:\/\/(?:www\.)?dropbox\.com\//i.test(cleaned)) {
    cleaned = cleaned
      .replace(/^https?:\/\/(?:www\.)?dropbox\.com\//i, 'https://dl.dropboxusercontent.com/')
      .replace(/[?&]dl=0\b/i, '');
  }

  cleaned = cleaned.replace(/ /g, '%20');

  return { url: cleaned, pipeUa, pipeReferer };
}

interface UpstreamResult {
  res: http.IncomingMessage;
  finalUrl: string;
  usedUa: string;
  usedReferer?: string;
  cookieHeader?: string;
  destroy: () => void;
}

/**
 * Low-level HTTP/HTTPS request with insecureHTTPParser, legacy TLS support,
 * manual redirect following (up to 8 hops), space encoding in Location headers,
 * and cookie forwarding across redirects.
 */
function requestSingleAttempt(
  startUrl: string,
  options: {
    userAgent: string;
    referer?: string;
    range?: string;
    timeoutMs?: number;
  }
): Promise<UpstreamResult> {
  return new Promise((resolve, reject) => {
    const cookies: string[] = [];
    let currentReq: http.ClientRequest | null = null;
    let settled = false;

    const follow = (targetUrl: string, redirectsLeft: number) => {
      if (settled) return;
      if (redirectsLeft < 0) {
        settled = true;
        reject(new Error('Too many redirects'));
        return;
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(targetUrl.replace(/ /g, '%20'));
      } catch (err) {
        settled = true;
        reject(err);
        return;
      }

      const isHttps = parsedUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const reqHeaders: Record<string, string> = {
        'User-Agent': options.userAgent,
        Accept: '*/*',
      };

      if (options.referer) {
        reqHeaders['Referer'] = options.referer;
      }
      if (options.range) {
        reqHeaders['Range'] = options.range;
      }
      if (cookies.length > 0) {
        reqHeaders['Cookie'] = cookies.join('; ');
      }

      const reqOptions: https.RequestOptions = {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: reqHeaders,
        insecureHTTPParser: true,
        rejectUnauthorized: false,
        ciphers: 'DEFAULT:@SECLEVEL=0',
        timeout: options.timeoutMs || 20000,
      };

      const req = transport.request(reqOptions, (res) => {
        if (settled) {
          res.resume();
          return;
        }

        const setCookie = res.headers['set-cookie'];
        if (Array.isArray(setCookie)) {
          setCookie.forEach((c) => {
            const pair = c.split(';')[0]?.trim();
            if (pair && !cookies.includes(pair)) cookies.push(pair);
          });
        }

        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          const rawLocation = String(res.headers.location).trim().replace(/ /g, '%20');
          res.resume();
          try {
            const nextUrl = new URL(rawLocation, parsedUrl).toString();
            follow(nextUrl, redirectsLeft - 1);
          } catch (err) {
            settled = true;
            reject(err);
          }
          return;
        }

        settled = true;
        resolve({
          res,
          finalUrl: parsedUrl.toString(),
          usedUa: options.userAgent,
          usedReferer: options.referer,
          cookieHeader: cookies.length > 0 ? cookies.join('; ') : undefined,
          destroy: () => {
            res.destroy();
            req.destroy();
          },
        });
      });

      currentReq = req;

      req.on('timeout', () => {
        req.destroy(new Error('Upstream connection timeout'));
      });

      req.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      req.end();
    };

    follow(startUrl, 8);
  });
}

/**
 * Resolves Archive.org /details/<id> or truncated Archive.org /download/<id>/<prefix> URLs,
 * as well as truncated directory filenames using the channel title.
 */
async function tryRecoverOrResolveSpecialVodUrl(
  targetUrl: string,
  channelTitle?: string
): Promise<string[]> {
  const candidates: string[] = [];

  // 1. Archive.org /details/<item> or /download/<item>/<file>
  const archiveMatch = targetUrl.match(
    /^https?:\/\/(?:www\.)?archive\.org\/(?:details|download)\/([^/?#]+)(?:\/([^?#]*))?/i
  );
  if (archiveMatch) {
    const itemId = archiveMatch[1];
    const subPath = archiveMatch[2] ? decodeURIComponent(archiveMatch[2]).trim() : '';
    try {
      const metaAttempt = await requestSingleAttempt(
        `https://archive.org/metadata/${encodeURIComponent(itemId)}`,
        { userAgent: DEFAULT_BROWSER_UA, timeoutMs: 8000 }
      );
      if (metaAttempt.res.statusCode === 200) {
        const chunks: Buffer[] = [];
        for await (const chunk of metaAttempt.res) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const metaJson = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          files?: Array<{ name?: string; format?: string }>;
        };
        const files = metaJson.files || [];
        const videoFiles = files.filter(
          (f) => f.name && /\.(mp4|mkv|webm|avi|mov|m4v|ts|flv)$/i.test(f.name)
        );

        const cleanTitle = (channelTitle || '').trim().toLowerCase();
        const cleanSub = subPath.toLowerCase();

        // Exact or prefix match on subPath or channelTitle
        const matched =
          videoFiles.find((f) => cleanSub && f.name!.toLowerCase() === cleanSub) ||
          videoFiles.find((f) => cleanSub && f.name!.toLowerCase().startsWith(cleanSub)) ||
          videoFiles.find(
            (f) =>
              cleanTitle &&
              (f.name!.toLowerCase().startsWith(cleanTitle) ||
                f.name!.toLowerCase().includes(cleanTitle))
          ) ||
          videoFiles[0];

        if (matched?.name) {
          const encodedName = matched.name
            .split('/')
            .map((seg) => encodeURIComponent(seg))
            .join('/');
          candidates.push(`https://archive.org/download/${itemId}/${encodedName}`);
        }
      } else {
        metaAttempt.destroy();
      }
    } catch {
      // ignore metadata lookup errors
    }
  }

  // 2. If URL has no media extension (e.g. truncated at space in localStorage) and channelTitle is known
  const hasMediaExt = /\.(mp4|mkv|m3u8|ts|webm|avi|mov|m4v|flv)(\?|$)/i.test(targetUrl);
  if (!hasMediaExt && channelTitle) {
    try {
      const u = new URL(targetUrl);
      const pathParts = u.pathname.split('/');
      const lastSeg = decodeURIComponent(pathParts[pathParts.length - 1] || '').trim();
      const cleanTitle = channelTitle.trim();
      if (
        lastSeg &&
        cleanTitle.toLowerCase().startsWith(lastSeg.toLowerCase()) &&
        cleanTitle.length > lastSeg.length
      ) {
        const baseDir = pathParts.slice(0, -1).join('/');
        const encodedTitle = encodeURIComponent(cleanTitle).replace(/%20/g, '%20');
        candidates.push(`${u.origin}${baseDir}/${encodedTitle}.mp4${u.search}`);
        candidates.push(`${u.origin}${baseDir}/${encodedTitle}.mkv${u.search}`);
      }
    } catch {
      // ignore
    }
  }

  return candidates;
}

/**
 * Connects to an upstream URL with automatic User-Agent & Referer fallback
 * and truncated/Archive.org URL recovery.
 */
async function connectUpstreamWithFallbacks(
  rawUrl: string,
  options: {
    customUa?: string;
    customReferer?: string;
    channelTitle?: string;
    range?: string;
  }
): Promise<UpstreamResult> {
  const { url: normalizedUrl, pipeUa, pipeReferer } = sanitizeAndNormalizeUrl(rawUrl);
  const effectiveUa = options.customUa || pipeUa;
  const effectiveRef = options.customReferer || pipeReferer;

  let originReferer: string | undefined;
  try {
    originReferer = `${new URL(normalizedUrl).origin}/`;
  } catch {
    // ignore
  }

  // If URL is an archive.org/details/<id> page, resolve it first
  let urlsToTry = [normalizedUrl];
  if (/^https?:\/\/(?:www\.)?archive\.org\/details\//i.test(normalizedUrl)) {
    const recovered = await tryRecoverOrResolveSpecialVodUrl(normalizedUrl, options.channelTitle);
    if (recovered.length > 0) {
      urlsToTry = [...recovered, normalizedUrl];
    }
  }

  const uaProfiles: Array<{ ua: string; ref?: string }> = [];
  if (effectiveUa) {
    uaProfiles.push({ ua: effectiveUa, ref: effectiveRef });
  }
  uaProfiles.push({ ua: DEFAULT_BROWSER_UA, ref: effectiveRef });
  uaProfiles.push({ ua: VLC_UA, ref: effectiveRef });
  uaProfiles.push({ ua: LAVF_UA, ref: effectiveRef || originReferer });
  if (!effectiveRef && originReferer) {
    uaProfiles.push({ ua: DEFAULT_BROWSER_UA, ref: originReferer });
  }

  let lastResult: UpstreamResult | null = null;
  let lastError: unknown = null;

  for (const candidateUrl of urlsToTry) {
    for (const profile of uaProfiles) {
      try {
        const res = await requestSingleAttempt(candidateUrl, {
          userAgent: profile.ua,
          referer: profile.ref,
          range: options.range,
        });
        const status = res.res.statusCode || 0;
        if (status >= 200 && status < 300) {
          if (lastResult) lastResult.destroy();
          return res;
        }
        if (lastResult) lastResult.destroy();
        lastResult = res;
        // If 404 on first profile, break profile loop and try recovered URLs
        if (status === 404) break;
      } catch (err) {
        lastError = err;
      }
    }
  }

  // If failed (e.g. 404 or error), try recovering truncated or Archive.org URL
  const recoveredUrls = await tryRecoverOrResolveSpecialVodUrl(normalizedUrl, options.channelTitle);
  for (const recUrl of recoveredUrls) {
    if (urlsToTry.includes(recUrl)) continue;
    try {
      const res = await requestSingleAttempt(recUrl, {
        userAgent: effectiveUa || DEFAULT_BROWSER_UA,
        referer: effectiveRef,
        range: options.range,
      });
      const status = res.res.statusCode || 0;
      if (status >= 200 && status < 300) {
        if (lastResult) lastResult.destroy();
        return res;
      }
      res.destroy();
    } catch (err) {
      lastError = err;
    }
  }

  if (lastResult) return lastResult;
  throw lastError || new Error('Failed to connect to upstream');
}

/**
 * Peeks at the first chunk of a readable stream so we can inspect magic bytes
 * (#EXTM3U vs MP4 vs MKV vs TS vs HTML) before sending HTTP headers.
 */
function peekFirstChunk(
  stream: http.IncomingMessage
): Promise<{ firstChunk: Buffer | null; stream: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      cleanup();
      stream.pause();
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      resolve({ firstChunk: buf, stream });
    };
    const onEnd = () => {
      cleanup();
      resolve({ firstChunk: null, stream });
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };
    stream.once('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

function detectMimeFromMagicBytes(
  firstChunk: Buffer | null,
  upstreamContentType: string,
  finalUrl: string
): string {
  if (firstChunk && firstChunk.length >= 12) {
    // 1. MP4 / MOV / M4V: bytes 4..7 are 'ftyp', 'moov', 'wide', 'mdat', or 'free'
    const boxType = firstChunk.subarray(4, 8).toString('ascii');
    if (['ftyp', 'moov', 'wide', 'mdat', 'free', 'styp'].includes(boxType)) {
      return 'video/mp4';
    }
    // 2. Matroska (.mkv) / WebM (.webm): EBML magic bytes 0x1A 0x45 0xDF 0xA3
    if (
      firstChunk[0] === 0x1a &&
      firstChunk[1] === 0x45 &&
      firstChunk[2] === 0xdf &&
      firstChunk[3] === 0xa3
    ) {
      const headerStr = firstChunk.subarray(0, Math.min(64, firstChunk.length)).toString('ascii');
      if (headerStr.toLowerCase().includes('webm')) {
        return 'video/webm';
      }
      return 'video/x-matroska';
    }
    // 3. MPEG-TS (.ts): sync byte 0x47 ('G') at offset 0 (and 188 if long enough)
    if (firstChunk[0] === 0x47 && (firstChunk.length < 189 || firstChunk[188] === 0x47)) {
      return 'video/mp2t';
    }
    // 4. FLV: 'FLV'
    if (firstChunk[0] === 0x46 && firstChunk[1] === 0x4c && firstChunk[2] === 0x56) {
      return 'video/x-flv';
    }
    // 5. AVI: 'RIFF' ... 'AVI '
    if (
      firstChunk.subarray(0, 4).toString('ascii') === 'RIFF' &&
      firstChunk.subarray(8, 12).toString('ascii') === 'AVI '
    ) {
      return 'video/x-msvideo';
    }
    // 6. OGG: 'OggS'
    if (firstChunk.subarray(0, 4).toString('ascii') === 'OggS') {
      return 'video/ogg';
    }
  }

  const lowerType = upstreamContentType.toLowerCase();
  if (
    lowerType.startsWith('video/') ||
    lowerType.startsWith('audio/')
  ) {
    return upstreamContentType;
  }

  if (/\.webm(\?|$)/i.test(finalUrl)) return 'video/webm';
  if (/\.mkv(\?|$)/i.test(finalUrl)) return 'video/x-matroska';
  if (/\.ts(\?|$)/i.test(finalUrl)) return 'video/mp2t';
  if (/\.ogg(\?|$)/i.test(finalUrl)) return 'video/ogg';
  return 'video/mp4';
}

/**
 * Inspects video codec via ffprobe (returns within 2.5s max) to decide whether
 * we can copy the H.264 bitstream (-c:v copy) or need to transcode (-c:v libx264).
 */
function probeVideoCodec(
  targetUrl: string,
  userAgent: string,
  referer?: string,
  cookieHeader?: string
): Promise<{ codecName: string; pixFmt: string } | null> {
  return new Promise((resolve) => {
    const args: string[] = [
      '-v',
      'error',
      '-tls_verify',
      '0',
      '-user_agent',
      userAgent,
    ];

    const headerLines: string[] = [];
    if (referer) headerLines.push(`Referer: ${referer}`);
    if (cookieHeader) headerLines.push(`Cookie: ${cookieHeader}`);
    if (headerLines.length > 0) {
      args.push('-headers', `${headerLines.join('\r\n')}\r\n`);
    }

    args.push(
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,pix_fmt',
      '-of',
      'json',
      targetUrl
    );

    const proc = spawn('ffprobe', args);
    let stdout = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve(null);
    }, 3000);

    proc.stdout.on('data', (d) => {
      stdout += String(d);
    });

    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout) as {
          streams?: Array<{ codec_name?: string; pix_fmt?: string }>;
        };
        const stream = parsed.streams?.[0];
        if (stream?.codec_name) {
          resolve({
            codecName: stream.codec_name.toLowerCase(),
            pixFmt: (stream.pix_fmt || 'yuv420p').toLowerCase(),
          });
          return;
        }
      } catch {
        // ignore
      }
      resolve(null);
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Handle CORS preflight for media range requests
  app.options(['/api/proxy', '/api/transcode', '/api/probe'], (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.sendStatus(204);
  });

  app.get('/api/probe', async (req, res) => {
    const rawTargetUrl = String(req.query.url || '').trim();
    const customUa = String(req.query.ua || '').trim();
    const customReferer = String(req.query.ref || '').trim();
    const channelTitle = String(req.query.title || '').trim();
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!rawTargetUrl) {
      res.json({ duration: null });
      return;
    }
    try {
      const upstream = await connectUpstreamWithFallbacks(rawTargetUrl, {
        customUa: customUa || undefined,
        customReferer: customReferer || undefined,
        channelTitle: channelTitle || undefined,
        range: 'bytes=0-65535',
      });
      const finalUrl = upstream.finalUrl;
      const usedUa = upstream.usedUa || customUa || DEFAULT_BROWSER_UA;
      const usedRef = upstream.usedReferer || customReferer;
      const cookies = upstream.cookieHeader;
      upstream.destroy();

      const args: string[] = [
        '-v',
        'error',
        '-tls_verify',
        '0',
        '-user_agent',
        usedUa,
        '-probesize',
        '5000000',
        '-analyzeduration',
        '5000000',
      ];
      const hdrs: string[] = [];
      if (usedRef) hdrs.push(`Referer: ${usedRef}`);
      if (cookies) hdrs.push(`Cookie: ${cookies}`);
      if (hdrs.length > 0) args.push('-headers', `${hdrs.join('\r\n')}\r\n`);
      args.push('-show_entries', 'format=duration:stream=duration', '-of', 'json', finalUrl);

      const proc = spawn('ffprobe', args);
      let out = '';
      const t = setTimeout(() => proc.kill('SIGKILL'), 8000);
      proc.stdout.on('data', (d) => {
        out += String(d);
      });
      proc.on('close', () => {
        clearTimeout(t);
        try {
          const parsed = JSON.parse(out) as {
            format?: { duration?: string | number };
            streams?: Array<{ duration?: string | number }>;
          };
          const dur =
            Number(parsed.format?.duration) ||
            Number(parsed.streams?.find((s) => Number(s?.duration) > 0)?.duration) ||
            0;
          if (Number.isFinite(dur) && dur > 0) {
            res.json({ duration: dur });
            return;
          }
        } catch {
          // ignore
        }
        res.json({ duration: null });
      });
      proc.on('error', () => {
        clearTimeout(t);
        res.json({ duration: null });
      });
    } catch {
      res.json({ duration: null });
    }
  });

  // ===========================================================================
  // 1. /api/proxy: Smart IPTV & VOD Proxy with Magic-Byte Sniffing, Redirect &
  //    Cookie Preservation, HTML Wrapper Extraction, and Byte-Range Streaming
  // ===========================================================================
  app.get('/api/proxy', async (req, res) => {
    const rawTargetUrl = String(req.query.url || '').trim();
    const customUa = String(req.query.ua || '').trim();
    const customReferer = String(req.query.ref || '').trim();
    const channelTitle = String(req.query.title || '').trim();

    if (!rawTargetUrl) {
      res.status(400).send('Missing target URL');
      return;
    }

    try {
      const upstream = await connectUpstreamWithFallbacks(rawTargetUrl, {
        customUa: customUa || undefined,
        customReferer: customReferer || undefined,
        channelTitle: channelTitle || undefined,
        range: req.headers.range ? String(req.headers.range) : undefined,
      });

      const status = upstream.res.statusCode || 200;
      if (status < 200 || status >= 300) {
        upstream.destroy();
        res.status(status).send(`Upstream error ${status}`);
        return;
      }

      const contentType = String(upstream.res.headers['content-type'] || '');
      const finalUrl = upstream.finalUrl;

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Length, Content-Range, Accept-Ranges, Content-Type'
      );

      // Peek at the first chunk to inspect magic bytes (#EXTM3U vs HTML vs binary video)
      const { firstChunk, stream } = await peekFirstChunk(upstream.res);

      const firstText = firstChunk
        ? firstChunk.subarray(0, Math.min(256, firstChunk.length)).toString('utf8').trimStart()
        : '';

      // Case A: Genuine HLS M3U8 Manifest (starts with #EXTM3U)
      if (firstText.startsWith('#EXTM3U')) {
        const chunks: Buffer[] = firstChunk ? [firstChunk] : [];
        let totalBytes = firstChunk ? firstChunk.length : 0;
        stream.resume();
        for await (const chunk of stream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.length;
          if (totalBytes > 8 * 1024 * 1024) break;
          chunks.push(buf);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        const baseUrl = new URL(finalUrl);
        const effectiveUa = customUa || upstream.usedUa || '';
        const effectiveRef = customReferer || upstream.usedReferer || '';
        const uaParam = effectiveUa ? `&ua=${encodeURIComponent(effectiveUa)}` : '';
        const refParam = effectiveRef ? `&ref=${encodeURIComponent(effectiveRef)}` : '';

        const rewritten = text
          .split(/\r?\n/)
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#')) {
              return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
                try {
                  const resolved = new URL(uri, baseUrl).toString();
                  return `URI="/api/proxy?url=${encodeURIComponent(resolved)}${uaParam}${refParam}"`;
                } catch {
                  return _match;
                }
              });
            }
            try {
              const resolved = new URL(trimmed, baseUrl).toString();
              return `/api/proxy?url=${encodeURIComponent(resolved)}${uaParam}${refParam}`;
            } catch {
              return line;
            }
          })
          .join('\n');

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.status(200).send(rewritten);
        return;
      }

      // Case B: Upstream returned an HTML page (e.g., playlist file, or Google Drive / file-host wrapper page)
      const isHtmlPayload =
        contentType.toLowerCase().includes('text/html') ||
        /^<!doctype\s+html/i.test(firstText) ||
        /^<html/i.test(firstText);

      if (isHtmlPayload) {
        const chunks: Buffer[] = firstChunk ? [firstChunk] : [];
        let totalBytes = firstChunk ? firstChunk.length : 0;
        stream.resume();
        for await (const chunk of stream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.length;
          if (totalBytes > 5 * 1024 * 1024) break;
          chunks.push(buf);
        }
        const htmlText = Buffer.concat(chunks).toString('utf8');

        // If this request is fetching an M3U/HTML playlist, return the text if it contains #EXTINF
        if (htmlText.includes('#EXTINF:')) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.status(200).send(htmlText);
          return;
        }

        // Check if HTML page has an embedded direct media link (<source src="..."> or direct .mp4/.mkv/.m3u8 URL)
        const embeddedMediaMatch =
          htmlText.match(
            /(?:src|href|file|url)\s*[:=]\s*["'](https?:\/\/[^"'<>]+\.(?:mp4|mkv|m3u8|webm|ts)(?:\?[^"'<>]*)?)["']/i
          ) ||
          htmlText.match(
            /action=["'](https:\/\/drive\.usercontent\.google\.com\/download[^"']+)["']/i
          );

        if (embeddedMediaMatch?.[1]) {
          const extractedMediaUrl = embeddedMediaMatch[1].replace(/&amp;/g, '&');
          res.redirect(
            302,
            `/api/proxy?url=${encodeURIComponent(extractedMediaUrl)}${
              customUa ? `&ua=${encodeURIComponent(customUa)}` : ''
            }${customReferer ? `&ref=${encodeURIComponent(customReferer)}` : ''}`
          );
          return;
        }

        // Otherwise return the HTML/text (e.g. for HTML playlist parser) if no Range header was sent,
        // or 415 if a <video> element requested a binary media stream
        if (req.headers.range) {
          res.status(415).send('Upstream returned HTML instead of video stream');
          return;
        }
        res.setHeader('Content-Type', contentType || 'text/html; charset=utf-8');
        res.status(200).send(htmlText);
        return;
      }

      // Case C: Plain-text M3U / XSPF playlist without #EXTM3U header at byte 0
      if (
        (firstText.includes('#EXTINF:') || firstText.startsWith('<?xml') || firstText.includes('<playlist')) &&
        !req.headers.range
      ) {
        const chunks: Buffer[] = firstChunk ? [firstChunk] : [];
        stream.resume();
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        res.setHeader('Content-Type', contentType || 'text/plain; charset=utf-8');
        res.status(200).send(Buffer.concat(chunks));
        return;
      }

      // Case D: Binary Media Stream (MP4, MKV, WebM, TS, AVI, FLV, etc.)
      const detectedMime = detectMimeFromMagicBytes(firstChunk, contentType, finalUrl);
      res.setHeader('Content-Type', detectedMime);
      res.setHeader('Content-Disposition', 'inline');

      const upstreamAcceptRanges = upstream.res.headers['accept-ranges'];
      const upstreamContentRange = upstream.res.headers['content-range'];
      const upstreamContentLength = upstream.res.headers['content-length'];

      if (
        status === 206 ||
        upstreamContentRange ||
        upstreamAcceptRanges === 'bytes' ||
        upstreamContentLength
      ) {
        res.setHeader('Accept-Ranges', 'bytes');
      }
      if (upstreamContentLength) {
        res.setHeader('Content-Length', String(upstreamContentLength));
      }
      if (upstreamContentRange) {
        res.setHeader('Content-Range', String(upstreamContentRange));
      }

      res.status(status);

      req.on('close', () => {
        upstream.destroy();
      });

      if (firstChunk) {
        res.write(firstChunk);
      }
      stream.on('error', () => {
        res.end();
      });
      stream.pipe(res);
      stream.resume();
    } catch {
      if (!res.headersSent) {
        res.status(502).send('Proxy fetch failed');
      }
    }
  });

  // ===========================================================================
  // 2. /api/transcode: Live FFmpeg Remux / Transcode Pipeline for VOD & Streams
  //    Converts MKV, HEVC/H.265, AC3/EAC3 Dolby audio, AVI, FLV, MPEG-TS (.ts),
  //    and non-faststart MP4 into browser-native fragmented MP4 (H.264 + AAC)
  // ===========================================================================
  app.get('/api/transcode', async (req, res) => {
    const rawTargetUrl = String(req.query.url || '').trim();
    const customUa = String(req.query.ua || '').trim();
    const customReferer = String(req.query.ref || '').trim();
    const channelTitle = String(req.query.title || '').trim();
    const mode = String(req.query.mode || 'remux').toLowerCase();
    const startSeconds = Number(req.query.ss || 0);

    if (!rawTargetUrl) {
      res.status(400).send('Missing target URL');
      return;
    }

    const useVideoCopy = mode === 'remux';
    let clientClosed = false;
    let activeFFmpeg: ReturnType<typeof spawn> | null = null;
    let activeUpstream: UpstreamResult | null = null;
    let sentHeaders = false;

    req.on('close', () => {
      clientClosed = true;
      if (activeUpstream) {
        try {
          activeUpstream.destroy();
        } catch {
          // ignore
        }
      }
      if (activeFFmpeg) {
        try {
          activeFFmpeg.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    });

    const buildOutputArgs = (): string[] => {
      return [
        '-map',
        '0:V:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '24',
        '-vf',
        "scale='trunc(min(1280,iw)/2)*2':-2,format=yuv420p",
        '-profile:v',
        'main',
        '-level',
        '4.0',
        '-g',
        '50',
        '-c:a',
        'aac',
        '-ac',
        '2',
        '-ar',
        '44100',
        '-b:a',
        '128k',
        '-sn',
        '-f',
        'mp4',
        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof',
        'pipe:1',
      ];
    };

    const runDirectUrlFFmpeg = (
      targetUrl: string,
      ua: string,
      ref?: string,
      cookies?: string
    ) => {
      if (clientClosed) return;
      const args: string[] = ['-hide_banner', '-loglevel', 'error', '-tls_verify', '0'];

      if (/^https?:\/\//i.test(targetUrl)) {
        args.push(
          '-user_agent',
          ua,
          '-reconnect',
          '1',
          '-reconnect_streamed',
          '1',
          '-reconnect_delay_max',
          '5'
        );
        const headerLines: string[] = [];
        if (ref) headerLines.push(`Referer: ${ref}`);
        if (cookies) headerLines.push(`Cookie: ${cookies}`);
        if (headerLines.length > 0) {
          args.push('-headers', `${headerLines.join('\r\n')}\r\n`);
        }
      }

      if (startSeconds > 0 && Number.isFinite(startSeconds)) {
        args.push('-ss', String(Math.floor(startSeconds)));
      }

      args.push('-fflags', '+genpts+discardcorrupt+igndts', '-i', targetUrl, ...buildOutputArgs());

      const ff = spawn('ffmpeg', args);
      activeFFmpeg = ff;

      ff.stdout.on('data', (chunk: Buffer) => {
        if (clientClosed) return;
        if (!sentHeaders) {
          sentHeaders = true;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Content-Disposition', 'inline');
          res.setHeader('Cache-Control', 'no-store');
          res.status(200);
        }
        res.write(chunk);
      });

      ff.on('close', () => {
        if (!clientClosed) {
          if (!sentHeaders && !res.headersSent) {
            res.status(502).send('Transcode failed to produce media output');
          } else {
            res.end();
          }
        }
      });

      ff.on('error', () => {
        if (!clientClosed && !res.headersSent) {
          res.status(502).send('Failed to spawn ffmpeg');
        }
      });
    };

    // Non-HTTP protocols (rtmp://, rtsp://, udp://, mms://) go straight to FFmpeg
    if (!/^https?:\/\//i.test(rawTargetUrl) && !rawTargetUrl.startsWith('//')) {
      const normalized = sanitizeAndNormalizeUrl(rawTargetUrl);
      runDirectUrlFFmpeg(
        normalized.url,
        customUa || normalized.pipeUa || DEFAULT_BROWSER_UA,
        customReferer || normalized.pipeReferer
      );
      return;
    }

    try {
      const upstream = await connectUpstreamWithFallbacks(rawTargetUrl, {
        customUa: customUa || undefined,
        customReferer: customReferer || undefined,
        channelTitle: channelTitle || undefined,
      });
      activeUpstream = upstream;

      const status = upstream.res.statusCode || 0;
      if (status < 200 || status >= 300) {
        upstream.destroy();
        res.status(status || 502).send(`Upstream returned ${status}`);
        return;
      }

      const { firstChunk, stream } = await peekFirstChunk(upstream.res);
      if (clientClosed) {
        upstream.destroy();
        return;
      }

      const firstText = firstChunk
        ? firstChunk.subarray(0, Math.min(256, firstChunk.length)).toString('utf8').trimStart()
        : '';

      // If upstream is an HLS M3U8 manifest or seeking was requested, use direct URL input so FFmpeg can fetch segments / seek via HTTP Range
      const isM3u8 = firstText.startsWith('#EXTM3U');
      const isMp4Box =
        firstChunk &&
        firstChunk.length >= 12 &&
        ['ftyp', 'moov', 'wide', 'mdat', 'free'].includes(
          firstChunk.subarray(4, 8).toString('ascii')
        );
      const hasMoovInFirstChunk =
        firstChunk && firstChunk.includes(Buffer.from('moov', 'ascii'));

      if (isM3u8 || startSeconds > 0 || (isMp4Box && !hasMoovInFirstChunk)) {
        const finalUrl = upstream.finalUrl;
        const usedUa = upstream.usedUa;
        const usedRef = upstream.usedReferer;
        const cookieHeader = upstream.cookieHeader;
        upstream.destroy();
        activeUpstream = null;
        runDirectUrlFFmpeg(finalUrl, usedUa, usedRef, cookieHeader);
        return;
      }

      // Otherwise, pipe the already-open single connection directly into ffmpeg stdin (pipe:0)
      const pipeArgs: string[] = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-fflags',
        '+genpts+discardcorrupt+igndts',
        '-i',
        'pipe:0',
        ...buildOutputArgs(),
      ];

      const ff = spawn('ffmpeg', pipeArgs);
      activeFFmpeg = ff;

      ff.stdin.on('error', () => {
        // Ignore EPIPE when ffmpeg exits early
      });

      if (firstChunk) {
        ff.stdin.write(firstChunk);
      }
      stream.pipe(ff.stdin);
      stream.resume();

      ff.stdout.on('data', (chunk: Buffer) => {
        if (clientClosed) return;
        if (!sentHeaders) {
          sentHeaders = true;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Content-Disposition', 'inline');
          res.setHeader('Cache-Control', 'no-store');
          res.status(200);
        }
        res.write(chunk);
      });

      ff.on('close', () => {
        if (clientClosed) return;
        if (!sentHeaders) {
          // Fallback: if pipe:0 failed (e.g. container needs HTTP Range seeking), retry via direct URL
          const finalUrl = upstream.finalUrl;
          const usedUa = upstream.usedUa;
          const usedRef = upstream.usedReferer;
          const cookieHeader = upstream.cookieHeader;
          upstream.destroy();
          activeUpstream = null;
          runDirectUrlFFmpeg(finalUrl, usedUa, usedRef, cookieHeader);
        } else {
          res.end();
        }
      });

      ff.on('error', () => {
        if (!clientClosed && !res.headersSent) {
          res.status(502).send('Failed to spawn ffmpeg');
        }
      });
    } catch {
      if (!res.headersSent) {
        res.status(502).send('Upstream unreachable');
      }
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
