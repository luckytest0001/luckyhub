import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import {
  ArrowLeft,
  ChevronLeft,
  Star,
  MoreVertical,
} from 'lucide-react';
import {
  Channel,
  DEFAULT_PLAYER_USER_AGENT,
  buildAuthenticatedXtreamAltUrls,
  isYouTubeChannelUrl,
  openExternalChannelLink,
  repairAndNormalizeChannel,
  resolveClientSideVodUrls,
} from '../utils/playlistParser';
import {
  buildPublicCorsProxyUrls,
  canUseBackendProxy,
  ensureBackendProbed,
  getEffectiveApiBaseUrl,
  getHttpsSafeMediaUrls,
  isStaticHostEnvironment,
} from '../utils/proxyHelper';

interface VideoPlayerModalProps {
  channel: Channel;
  channels: Channel[];
  allChannels?: Channel[];
  isFavorite: boolean;
  onToggleFavorite: (channelId: string) => void;
  onSelectChannel: (channel: Channel) => void;
  onClose: () => void;
  onOpenSettings?: () => void;
  userAgent?: string;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const totalSecs = Math.floor(seconds);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function appendChannelAuthQueryParams(
  channel: Channel,
  fallbackUa?: string,
  overrideTargetUrl?: string
): string {
  const targetUrl = overrideTargetUrl || channel.url;
  let qs = `url=${encodeURIComponent(targetUrl)}`;
  const effectiveUa = channel.userAgent || fallbackUa || DEFAULT_PLAYER_USER_AGENT;
  if (effectiveUa) {
    qs += `&ua=${encodeURIComponent(effectiveUa)}`;
  }
  if (channel.referer) {
    qs += `&ref=${encodeURIComponent(channel.referer)}`;
  }
  if (channel.macAddress) {
    qs += `&mac=${encodeURIComponent(channel.macAddress)}`;
  }
  if (channel.cookie) {
    qs += `&cookie=${encodeURIComponent(channel.cookie)}`;
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
  return qs;
}

function buildProxyUrl(
  channel: Channel,
  fallbackUa?: string,
  overrideTargetUrl?: string,
  baseUrlOverride?: string
): string {
  const base = baseUrlOverride !== undefined ? baseUrlOverride : getEffectiveApiBaseUrl();
  return `${base}/api/proxy?${appendChannelAuthQueryParams(channel, fallbackUa, overrideTargetUrl)}`;
}

function buildTranscodeUrl(
  channel: Channel,
  mode: 'remux' | 'full',
  seekSec = 0,
  fallbackUa?: string,
  overrideTargetUrl?: string,
  baseUrlOverride?: string
): string {
  const base = baseUrlOverride !== undefined ? baseUrlOverride : getEffectiveApiBaseUrl();
  let url = `${base}/api/transcode?mode=${mode}&${appendChannelAuthQueryParams(
    channel,
    fallbackUa,
    overrideTargetUrl
  )}`;
  if (seekSec > 0) {
    url += `&ss=${Math.floor(seekSec)}`;
  }
  return url;
}

function buildProbeUrl(
  channel: Channel,
  fallbackUa?: string,
  baseUrlOverride?: string
): string {
  const base = baseUrlOverride !== undefined ? baseUrlOverride : getEffectiveApiBaseUrl();
  return `${base}/api/probe?${appendChannelAuthQueryParams(channel, fallbackUa)}`;
}

const ASPECT_RATIO_LABELS = [
  'Best Fit',
  'Fit Horizontal',
  'Fit Vertical',
  'Fill',
  '16:9',
  '4:3',
  'Center',
] as const;

const SHOW_CLOCK_LABELS = [
  'Never',
  'When UI controls are visible',
  'Always',
] as const;

export const VideoPlayerModal: React.FC<VideoPlayerModalProps> = ({
  channel,
  channels,
  allChannels,
  isFavorite,
  onToggleFavorite,
  onSelectChannel,
  onClose,
  userAgent,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeDrawerItemRef = useRef<HTMLDivElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [aspectMode, setAspectMode] = useState<'fill' | 'cover' | 'contain'>('fill');
  const [showControls, setShowControls] = useState(true);
  const [logoError, setLogoError] = useState(false);
  const [showChannelDrawer, setShowChannelDrawer] = useState(false);
  const [drawerView, setDrawerView] = useState<'channels' | 'categories'>('channels');
  const [drawerCategory, setDrawerCategory] = useState<string>('All Channels');
  const [clockText, setClockText] = useState<string>(() =>
    new Date().toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  );
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showPlayerSettings, setShowPlayerSettings] = useState(false);
  const [accelMode, setAccelMode] = useState<'HW+' | 'HW' | 'SW'>('HW+');
  const [showAccelSubmenu, setShowAccelSubmenu] = useState(false);
  const [isScreenLocked, setIsScreenLocked] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [playerToast, setPlayerToast] = useState<string | null>(null);

  // Player in-screen Settings popup sliders (matching Screenshot_20261009-204818_IPTV.jpg)
  const [brightness, setBrightness] = useState<number>(92);
  const [volume, setVolume] = useState<number>(100);
  const [gestureHud, setGestureHud] = useState<'brightness' | 'volume' | null>(null);
  const [aspectRatioIdx, setAspectRatioIdx] = useState<number>(0); // 0 = 'Best Fit'
  const [videoScale, setVideoScale] = useState<number>(100); // 50% to 200%, default 100%
  const [showClockIdx, setShowClockIdx] = useState<number>(0); // 0 = 'Never'

  const gestureHudTimeoutRef = useRef<number | null>(null);
  const suppressNextClickRef = useRef<boolean>(false);
  const gestureStateRef = useRef<{
    active: boolean;
    moved: boolean;
    side: 'left' | 'right';
    startY: number;
    startBrightness: number;
    startVolume: number;
  }>({
    active: false,
    moved: false,
    side: 'left',
    startY: 0,
    startBrightness: 92,
    startVolume: 100,
  });

  const triggerPlayerToast = (msg: string) => {
    setPlayerToast(msg);
    window.setTimeout(() => {
      setPlayerToast((prev) => (prev === msg ? null : prev));
    }, 2500);
  };

  // Timeline state: supports both LIVE streams ("00:07 ————— LIVE") and VOD ("00:15 ●———— 1:08:24")
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [isLiveStream, setIsLiveStream] = useState(true);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);
  const seekBaseOffsetRef = useRef<number>(0);
  const isScrubbingRef = useRef<boolean>(false);
  const knownVodDurationRef = useRef<number | null>(null);
  const userPausedRef = useRef<boolean>(false);
  const playerControlRef = useRef<{
    seekTo: (targetSec: number) => void;
  } | null>(null);

  const currentIndex = channels.findIndex((c) => c.id === channel.id);
  const isFavChannelTitle = /\bFAV\b/i.test(channel.name);

  const fullChannelList = allChannels && allChannels.length > 0 ? allChannels : channels;

  const drawerCategories = React.useMemo(() => {
    return ['All Channels'];
  }, []);

  const drawerChannels = React.useMemo(() => {
    return fullChannelList;
  }, [fullChannelList]);

  useEffect(() => {
    const updateClock = () => {
      setClockText(
        new Date().toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        })
      );
    };
    updateClock();
    const timer = window.setInterval(updateClock, 15000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (showChannelDrawer && activeDrawerItemRef.current) {
      activeDrawerItemRef.current.scrollIntoView({ block: 'center' });
    }
  }, [showChannelDrawer, drawerView]);

  useEffect(() => {
    const normalizedChannel = repairAndNormalizeChannel(channel);
    const cleanUrl = normalizedChannel.url;

    if (isYouTubeChannelUrl(cleanUrl)) {
      openExternalChannelLink(cleanUrl);
      onClose();
      return;
    }

    setLogoError(false);
    setHasError(false);
    setIsLoading(true);
    setIsPlaying(true);
    setShowControls(true);
    setCurrentTime(0);
    setDuration(null);
    setIsLiveStream(true);
    setIsScrubbing(false);
    setScrubTime(0);
    seekBaseOffsetRef.current = 0;
    isScrubbingRef.current = false;
    knownVodDurationRef.current = null;
    userPausedRef.current = false;

    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    let mpegtsPlayer: mpegts.Player | null = null;
    let recoveredMediaError = false;
    let isMounted = true;
    let currentAttemptIdx = 0;
    let attemptToken = 0;
    let isTransitioning = false;
    let hasPlaybackStarted = false;
    let lastKnownTimestamp = 0;
    let pendingInitialSeekSec = 0;
    let reconnectRetries = 0;
    let transitionTimer: number | null = null;
    let stallTimer: number | null = null;
    let noVideoTimer: number | null = null;
    let reconnectTimer: number | null = null;
    let waitingWatchdogTimer: number | null = null;
    let seekFallbackTimer: number | null = null;

    const clearWaitingWatchdog = () => {
      if (waitingWatchdogTimer !== null) {
        window.clearTimeout(waitingWatchdogTimer);
        waitingWatchdogTimer = null;
      }
    };

    const clearSeekFallbackTimer = () => {
      if (seekFallbackTimer !== null) {
        window.clearTimeout(seekFallbackTimer);
        seekFallbackTimer = null;
      }
    };

    const clearTimers = () => {
      if (transitionTimer !== null) {
        window.clearTimeout(transitionTimer);
        transitionTimer = null;
      }
      if (stallTimer !== null) {
        window.clearTimeout(stallTimer);
        stallTimer = null;
      }
      if (noVideoTimer !== null) {
        window.clearTimeout(noVideoTimer);
        noVideoTimer = null;
      }
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearWaitingWatchdog();
      clearSeekFallbackTimer();
    };

    const destroyPlayers = () => {
      if (hls) {
        try {
          hls.destroy();
        } catch {
          // ignore
        }
        hls = null;
      }
      if (mpegtsPlayer) {
        try {
          mpegtsPlayer.unload();
          mpegtsPlayer.detachMediaElement();
          mpegtsPlayer.destroy();
        } catch {
          // ignore
        }
        mpegtsPlayer = null;
      }
    };

    const triggerStreamError = () => {
      if (!isMounted) return;
      clearTimers();
      setIsLoading(false);
      setIsPlaying(false);
      setHasError(true);
      setShowControls(false);
    };

    if (
      !cleanUrl ||
      !/^(https?:\/\/|rtmp:\/\/|rtsp:\/\/|udp:\/\/|mms:\/\/)/i.test(cleanUrl)
    ) {
      triggerStreamError();
      return;
    }

    const isHttpProtocol = /^https?:\/\//i.test(cleanUrl);
    const isHttpsUrl = /^https:\/\//i.test(cleanUrl);
    const isPageHttps =
      typeof window !== 'undefined' && window.location.protocol === 'https:';
    const isStaticDeploy = isStaticHostEnvironment();
    const hasMacAuth =
      Boolean(normalizedChannel.macAddress) ||
      Boolean(normalizedChannel.cookie) ||
      Boolean(normalizedChannel.authToken);
    const hasMacOrXtreamAuth =
      hasMacAuth || Boolean(normalizedChannel.xtreamParams);

    const mustUseProxyOnly =
      !isHttpProtocol ||
      (/^http:\/\//i.test(cleanUrl) && isPageHttps) ||
      Boolean(normalizedChannel.referer) ||
      hasMacAuth;

    const isExplicitM3u8 = /\.m3u8(\?|$|#|&)/i.test(cleanUrl);
    const isExplicitTsOrFlv =
      /\.(ts|flv)(\?|$|#|&)/i.test(cleanUrl) ||
      /[?&](?:extension|output)=ts\b/i.test(cleanUrl);
    const isMkvAviOrLegacyContainer =
      /\.(mkv|avi|wmv|mpg|mpeg|3gp|divx)(\?|$|#|&)/i.test(cleanUrl);
    const isExplicitNativeVod =
      /\.(mp4|webm|mov|m4v|ogg)(\?|$|#|&)/i.test(cleanUrl) ||
      /\/(movie|series|vod)\//i.test(cleanUrl) ||
      normalizedChannel.xtreamParams?.streamType === 'movie' ||
      normalizedChannel.xtreamParams?.streamType === 'series' ||
      /archive\.org|drive\.usercontent\.google\.com|drive\.google\.com|pixeldrain\.com|dropbox\.com|dropboxusercontent\.com/i.test(
        cleanUrl
      );

    // Optional HTTPS-upgraded direct candidate for http:// VOD/HLS URLs on standard port 80
    const httpsUpgradedUrl =
      /^http:\/\/[^/:]+(\/|$)/i.test(cleanUrl)
        ? cleanUrl.replace(/^http:\/\//i, 'https://')
        : undefined;

    let proxyUrl = buildProxyUrl(normalizedChannel, userAgent);
    let transcodeFullUrl = buildTranscodeUrl(normalizedChannel, 'full', 0, userAgent);
    const xtreamAltUrls = buildAuthenticatedXtreamAltUrls(normalizedChannel);
    const xtreamHlsProxyUrl =
      xtreamAltUrls.hlsUrl && xtreamAltUrls.hlsUrl !== cleanUrl
        ? buildProxyUrl(normalizedChannel, userAgent, xtreamAltUrls.hlsUrl)
        : undefined;
    const xtreamTsProxyUrl =
      xtreamAltUrls.tsUrl && xtreamAltUrls.tsUrl !== cleanUrl
        ? buildProxyUrl(normalizedChannel, userAgent, xtreamAltUrls.tsUrl)
        : undefined;

    const attempts: Array<{
      mode: 'native' | 'hls' | 'mpegts';
      url: string;
      isDirect?: boolean;
    }> = [];

    const pushAttempt = (mode: 'native' | 'hls' | 'mpegts', url?: string, isDirect?: boolean) => {
      if (!url) return;
      if (!attempts.some((a) => a.mode === mode && a.url === url)) {
        attempts.push({ mode, url, isDirect });
      }
    };

    const corsProxyUrls = buildPublicCorsProxyUrls(cleanUrl);
    const httpsSafeCleanUrls = getHttpsSafeMediaUrls(cleanUrl);

    if (!isHttpProtocol) {
      // RTMP / RTSP / UDP / MMS streams handled via server-side FFmpeg H.264 transcode
      pushAttempt('native', transcodeFullUrl);
    } else if (isExplicitM3u8) {
      // 1. Try Direct Browser HLS first if HTTPS (or on static deploy like GitHub Pages) & no MAC auth
      if ((!mustUseProxyOnly || isStaticDeploy) && Hls.isSupported()) {
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('hls', safeUrl, true);
        }
      }
      // 2. Backend Proxy HLS
      if (Hls.isSupported()) {
        pushAttempt('hls', proxyUrl);
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('hls', safeUrl, true);
        }
      }
      // 3. If Xtream Codes live stream, also try the authenticated .ts endpoint
      if (xtreamTsProxyUrl && mpegts.isSupported()) {
        pushAttempt('mpegts', xtreamTsProxyUrl);
      }
      if (xtreamAltUrls.tsUrl && mpegts.isSupported()) {
        for (const safeTsUrl of getHttpsSafeMediaUrls(xtreamAltUrls.tsUrl)) {
          pushAttempt('mpegts', safeTsUrl, true);
        }
      }
      // 4. Native HLS fallback (Safari / iOS / Android WebView native HLS)
      if (!mustUseProxyOnly || isStaticDeploy) {
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('native', safeUrl, true);
        }
      }
      pushAttempt('native', proxyUrl);
      pushAttempt('native', cleanUrl, true);
      pushAttempt('native', transcodeFullUrl);
    } else if (isExplicitTsOrFlv) {
      if (mpegts.isSupported()) {
        if (isStaticDeploy) {
          for (const safeUrl of httpsSafeCleanUrls) {
            pushAttempt('mpegts', safeUrl, true);
          }
        }
        pushAttempt('mpegts', proxyUrl);
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('mpegts', safeUrl, true);
        }
      }
      if (Hls.isSupported()) {
        if (xtreamHlsProxyUrl) {
          pushAttempt('hls', xtreamHlsProxyUrl);
        }
        if (xtreamAltUrls.hlsUrl) {
          for (const safeHlsUrl of getHttpsSafeMediaUrls(xtreamAltUrls.hlsUrl)) {
            pushAttempt('hls', safeHlsUrl, true);
          }
        }
        pushAttempt('hls', proxyUrl);
      }
      pushAttempt('native', transcodeFullUrl);
      for (const safeUrl of httpsSafeCleanUrls) {
        pushAttempt('native', safeUrl, true);
      }
    } else if (isMkvAviOrLegacyContainer) {
      // On GitHub Pages / static hosts (or for HTTPS MKVs where browser plays Matroska natively),
      // include MP4 Xtream variants and HTTPS-bridged direct playback so video & audio both work!
      if (isStaticDeploy) {
        if (xtreamAltUrls.vodMp4Url) {
          for (const safeMp4 of getHttpsSafeMediaUrls(xtreamAltUrls.vodMp4Url)) {
            pushAttempt('native', safeMp4, true);
          }
        }
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('native', safeUrl, true);
        }
      }
      pushAttempt('native', transcodeFullUrl);
      pushAttempt('native', proxyUrl);
      if (xtreamAltUrls.vodMp4Url) {
        pushAttempt('native', buildProxyUrl(normalizedChannel, userAgent, xtreamAltUrls.vodMp4Url));
        for (const safeMp4 of getHttpsSafeMediaUrls(xtreamAltUrls.vodMp4Url)) {
          pushAttempt('native', safeMp4, true);
        }
      }
      for (const safeUrl of httpsSafeCleanUrls) {
        pushAttempt('native', safeUrl, true);
      }
    } else if (isExplicitNativeVod) {
      // Standard VOD (.mp4, .webm, .mov, /movie/, /series/, /vod/, Archive.org, Google Drive, Dropbox, Pixeldrain):
      // Prioritize HTTPS-safe Direct & CORS-bridged playback so both https:// and http:// VODs play on GitHub Pages!
      if ((isHttpsUrl || !isPageHttps || isStaticDeploy) && !hasMacAuth) {
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('native', safeUrl, true);
        }
      }
      pushAttempt('native', proxyUrl);
      for (const safeUrl of httpsSafeCleanUrls) {
        pushAttempt('native', safeUrl, true);
      }
      if (xtreamAltUrls.vodMp4Url && xtreamAltUrls.vodMp4Url !== cleanUrl) {
        for (const safeMp4 of getHttpsSafeMediaUrls(xtreamAltUrls.vodMp4Url)) {
          pushAttempt('native', safeMp4, true);
        }
        pushAttempt('native', buildProxyUrl(normalizedChannel, userAgent, xtreamAltUrls.vodMp4Url));
      }
      if (xtreamAltUrls.vodMkvUrl && xtreamAltUrls.vodMkvUrl !== cleanUrl) {
        pushAttempt('native', buildProxyUrl(normalizedChannel, userAgent, xtreamAltUrls.vodMkvUrl));
        for (const safeMkv of getHttpsSafeMediaUrls(xtreamAltUrls.vodMkvUrl)) {
          pushAttempt('native', safeMkv, true);
        }
      }
      pushAttempt('native', transcodeFullUrl);
      if (Hls.isSupported()) {
        pushAttempt('hls', proxyUrl);
        for (const safeUrl of httpsSafeCleanUrls) {
          pushAttempt('hls', safeUrl, true);
        }
      }
    } else {
      // Extensionless live IPTV URLs (e.g. Xtream Codes /live/user/pass/123, /user/pass/123, Stalker play/live.php?mac=...)
      if (normalizedChannel.xtreamParams?.streamType === 'live') {
        if (Hls.isSupported()) {
          if (isStaticDeploy && xtreamAltUrls.hlsUrl) {
            for (const safeHls of getHttpsSafeMediaUrls(xtreamAltUrls.hlsUrl)) {
              pushAttempt('hls', safeHls, true);
            }
          }
          if (xtreamHlsProxyUrl) {
            pushAttempt('hls', xtreamHlsProxyUrl);
          }
          if (xtreamAltUrls.hlsUrl) {
            for (const safeHls of getHttpsSafeMediaUrls(xtreamAltUrls.hlsUrl)) {
              pushAttempt('hls', safeHls, true);
            }
          }
          pushAttempt('hls', proxyUrl);
        }
        if (mpegts.isSupported()) {
          pushAttempt('mpegts', xtreamTsProxyUrl || proxyUrl);
          if (xtreamAltUrls.tsUrl) {
            for (const safeTs of getHttpsSafeMediaUrls(xtreamAltUrls.tsUrl)) {
              pushAttempt('mpegts', safeTs, true);
            }
          }
        }
      } else {
        if (Hls.isSupported()) {
          if (!mustUseProxyOnly || isStaticDeploy) {
            for (const safeUrl of httpsSafeCleanUrls) {
              pushAttempt('hls', safeUrl, true);
            }
          }
          pushAttempt('hls', proxyUrl);
          for (const safeUrl of httpsSafeCleanUrls) {
            pushAttempt('hls', safeUrl, true);
          }
        }
        if (mpegts.isSupported()) {
          pushAttempt('mpegts', proxyUrl);
          for (const safeUrl of httpsSafeCleanUrls) {
            pushAttempt('mpegts', safeUrl, true);
          }
        }
      }
      pushAttempt('native', proxyUrl);
      for (const safeUrl of httpsSafeCleanUrls) {
        pushAttempt('native', safeUrl, true);
      }
      pushAttempt('native', transcodeFullUrl);
    }

    const probeController = new AbortController();
    const requestProbeDuration = () => {
      if (
        !isMounted ||
        !canUseBackendProxy() ||
        (knownVodDurationRef.current && knownVodDurationRef.current > 0)
      ) {
        return;
      }
      fetch(buildProbeUrl(normalizedChannel, userAgent), {
        signal: probeController.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { duration?: number | null } | null) => {
          if (isMounted && data?.duration && Number.isFinite(data.duration) && data.duration > 0) {
            const bestDur = Math.max(knownVodDurationRef.current || 0, data.duration);
            knownVodDurationRef.current = bestDur;
            setIsLiveStream(false);
            setDuration(bestDur);
          }
        })
        .catch(() => {});
    };

    const safePlayVideo = () => {
      if (userPausedRef.current) return;
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.catch((err: unknown) => {
          if (!isMounted) return;
          const errName = (err as { name?: string })?.name || '';
          if (errName === 'NotAllowedError') {
            video.muted = true;
            video.play().catch(() => {});
          }
        });
      }
    };

    const startTranscodeAt = (targetSec: number) => {
      if (!isMounted) return;
      const safeSec = Math.max(0, Math.floor(targetSec));

      // If backend transcode server is unavailable (e.g. pure static GitHub Pages without remote backend),
      // perform native seek or reload direct stream instead of failing on /api/transcode!
      if (!canUseBackendProxy()) {
        seekBaseOffsetRef.current = 0;
        try {
          video.currentTime = safeSec;
          safePlayVideo();
        } catch {
          // ignore
        }
        return;
      }

      clearTimers();
      seekBaseOffsetRef.current = safeSec;
      lastKnownTimestamp = safeSec;
      pendingInitialSeekSec = 0;

      const transcodeIdx = attempts.findIndex((a) => a.url.includes('/api/transcode'));
      if (transcodeIdx !== -1) {
        currentAttemptIdx = transcodeIdx;
      }

      attemptToken += 1;
      const myToken = attemptToken;
      recoveredMediaError = false;
      hasPlaybackStarted = false;
      isTransitioning = true;

      setHasError(false);
      setIsLoading(true);
      setIsPlaying(true);
      userPausedRef.current = false;

      destroyPlayers();
      video.removeAttribute('src');
      video.load();

      transitionTimer = window.setTimeout(() => {
        if (!isMounted || myToken !== attemptToken) return;
        isTransitioning = false;

        stallTimer = window.setTimeout(() => {
          if (!isMounted || myToken !== attemptToken || hasPlaybackStarted) return;
          // If transcode stalled, try direct/native fallback if available
          const directFallbackIdx = attempts.findIndex(
            (a) => a.isDirect && a.mode === 'native'
          );
          if (directFallbackIdx !== -1 && reconnectRetries >= 1) {
            runAttempt(directFallbackIdx, safeSec);
            return;
          }
          if (reconnectRetries < 3) {
            reconnectRetries += 1;
            startTranscodeAt(safeSec);
          } else {
            triggerStreamError();
          }
        }, 18000);

        const seekParam = safeSec > 0 ? `&ss=${safeSec}` : '';
        video.src = `${transcodeFullUrl}${seekParam}&_rc=${Date.now()}`;
        video.load();
        safePlayVideo();

        // Also refresh probe duration once FFmpeg has parsed the input header
        window.setTimeout(() => {
          if (isMounted && myToken === attemptToken) {
            requestProbeDuration();
          }
        }, 1500);
      }, 45);
    };

    const advanceToNextAttempt = (fromToken: number) => {
      if (!isMounted || fromToken !== attemptToken) return;
      let nextIdx = currentAttemptIdx + 1;
      // Skip backend /api/proxy and /api/transcode attempts if backend proxy was probed and found unreachable
      while (
        nextIdx < attempts.length &&
        !canUseBackendProxy() &&
        (attempts[nextIdx].url.includes('/api/proxy') ||
          attempts[nextIdx].url.includes('/api/transcode'))
      ) {
        nextIdx += 1;
      }
      runAttempt(nextIdx);
    };

    const jumpToTranscodeOrNext = (fromToken: number) => {
      if (!isMounted || fromToken !== attemptToken) return;
      if (!canUseBackendProxy()) {
        advanceToNextAttempt(fromToken);
        return;
      }
      if (lastKnownTimestamp > 2) {
        startTranscodeAt(lastKnownTimestamp);
        return;
      }
      const transcodeIdx = attempts.findIndex(
        (a, i) => i > currentAttemptIdx && a.url.includes('/api/transcode')
      );
      if (transcodeIdx !== -1) {
        runAttempt(transcodeIdx);
      } else {
        advanceToNextAttempt(fromToken);
      }
    };

    const runAttempt = (idx: number, resumeAtSec = 0) => {
      if (!isMounted) return;
      clearTimers();

      if (idx >= attempts.length) {
        triggerStreamError();
        return;
      }

      currentAttemptIdx = idx;
      attemptToken += 1;
      const myToken = attemptToken;
      const attempt = attempts[idx];
      recoveredMediaError = false;
      hasPlaybackStarted = false;
      pendingInitialSeekSec = resumeAtSec > 1 ? resumeAtSec : 0;
      let preStartNetworkErrors = 0;

      if (attempt.url.includes('/api/transcode') && pendingInitialSeekSec > 0) {
        startTranscodeAt(pendingInitialSeekSec);
        return;
      }

      seekBaseOffsetRef.current = 0;

      // Guard against asynchronous error events fired by detaching previous media sources
      isTransitioning = true;
      destroyPlayers();
      video.removeAttribute('src');
      video.load();

      transitionTimer = window.setTimeout(() => {
        if (!isMounted || myToken !== attemptToken) return;
        isTransitioning = false;

        // Set a safety stall timeout in case this attempt hangs without starting playback
        const timeoutMs = attempt.isDirect
          ? 6500
          : attempt.url.includes('/api/transcode')
          ? 20000
          : 12000;
        stallTimer = window.setTimeout(() => {
          if (!isMounted || myToken !== attemptToken || hasPlaybackStarted) return;
          advanceToNextAttempt(myToken);
        }, timeoutMs);

        if (attempt.mode === 'hls' && Hls.isSupported()) {
          hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 60,
            startPosition: pendingInitialSeekSec > 0 ? pendingInitialSeekSec : -1,
            manifestLoadingTimeOut: attempt.isDirect ? 5500 : 10000,
            manifestLoadingMaxRetry: attempt.isDirect ? 0 : 1,
            levelLoadingTimeOut: attempt.isDirect ? 5500 : 10000,
            levelLoadingMaxRetry: attempt.isDirect ? 0 : 1,
            fragLoadingTimeOut: attempt.isDirect ? 6500 : 12000,
            fragLoadingMaxRetry: attempt.isDirect ? 0 : 2,
          });
          hls.loadSource(attempt.url);
          hls.attachMedia(video);

          hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
            if (!isMounted || myToken !== attemptToken) return;
            const levels = Array.isArray(data?.levels) ? data.levels : [];
            const isLevelUnsupportedOrAudioOnly = (lvl: {
              videoCodec?: string;
              width?: number;
              height?: number;
              attrs?: { CODECS?: string; RESOLUTION?: string };
            }) => {
              const codecs = `${lvl.videoCodec || ''} ${lvl.attrs?.CODECS || ''}`.toLowerCase();
              if (/hev1|hvc1|hevc|mp4v|mpeg2/i.test(codecs)) return true;
              // Detect audio-only variant streams (e.g. mp4a.40.2 with no avc1/vp9/av01 and no resolution)
              const hasAudioCodec = /mp4a|aac|ac-3|ec-3|opus|vorbis|mp3/i.test(codecs);
              const hasVideoCodec = /avc1|vp09|vp9|av01|theora/i.test(codecs);
              const hasDimensions =
                (lvl.width && lvl.width > 0) ||
                (lvl.height && lvl.height > 0) ||
                Boolean(lvl.attrs?.RESOLUTION);
              if (hasAudioCodec && !hasVideoCodec && !hasDimensions && levels.length > 1) {
                return true;
              }
              return false;
            };

            if (levels.length > 0 && levels.every(isLevelUnsupportedOrAudioOnly)) {
              jumpToTranscodeOrNext(myToken);
              return;
            }

            // If some levels are H.264/AVC and others are HEVC or audio-only, lock to the best H.264 video level
            // so the browser never shows a black screen with audio only!
            if (hls && levels.length > 1 && levels.some(isLevelUnsupportedOrAudioOnly)) {
              const supportedIndices: number[] = [];
              levels.forEach((lvl, idx) => {
                if (!isLevelUnsupportedOrAudioOnly(lvl)) {
                  supportedIndices.push(idx);
                }
              });
              if (supportedIndices.length > 0) {
                const bestSupportedIdx = supportedIndices[supportedIndices.length - 1];
                hls.currentLevel = bestSupportedIdx;
                hls.loadLevel = bestSupportedIdx;
              }
            }

            if (pendingInitialSeekSec > 0) {
              try {
                video.currentTime = pendingInitialSeekSec;
              } catch {
                // ignore
              }
              pendingInitialSeekSec = 0;
            }
            safePlayVideo();
          });

          hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
            if (!isMounted || myToken !== attemptToken) return;
            const live = Boolean(data.details.live);
            setIsLiveStream(live);
            if (
              !live &&
              Number.isFinite(data.details.totalduration) &&
              data.details.totalduration > 0
            ) {
              const bestDur = Math.max(
                knownVodDurationRef.current || 0,
                data.details.totalduration
              );
              knownVodDurationRef.current = bestDur;
              setDuration(bestDur);
            }
          });

          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!isMounted || myToken !== attemptToken) return;
            // Fast fallback if network/CORS/segment error happens before playback has even started
            if (!hasPlaybackStarted && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              preStartNetworkErrors += 1;
              if (attempt.isDirect || data.fatal || preStartNetworkErrors >= 2) {
                advanceToNextAttempt(myToken);
                return;
              }
            }
            if (data.fatal) {
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMediaError) {
                recoveredMediaError = true;
                hls?.recoverMediaError();
              } else if ((hasPlaybackStarted || lastKnownTimestamp > 1) && reconnectRetries < 6) {
                reconnectRetries += 1;
                const savedTime = lastKnownTimestamp;
                setHasError(false);
                setIsLoading(true);
                if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
                reconnectTimer = window.setTimeout(() => {
                  if (!isMounted || myToken !== attemptToken) return;
                  if (attempt.isDirect) {
                    const proxyHlsIdx = attempts.findIndex(
                      (a, i) => i > currentAttemptIdx && a.mode === 'hls' && !a.isDirect
                    );
                    if (proxyHlsIdx !== -1) {
                      runAttempt(proxyHlsIdx, savedTime);
                      return;
                    }
                  }
                  if (reconnectRetries <= 3 && hls) {
                    hls.startLoad(savedTime > 1 ? savedTime : -1);
                    safePlayVideo();
                  } else {
                    startTranscodeAt(savedTime);
                  }
                }, 1000);
              } else {
                advanceToNextAttempt(myToken);
              }
            }
          });
        } else if (attempt.mode === 'mpegts' && mpegts.isSupported()) {
          const isFlv = /\.flv(\?|$|#|&)/i.test(cleanUrl);
          mpegtsPlayer = mpegts.createPlayer(
            {
              type: isFlv ? 'flv' : 'mpegts',
              isLive: true,
              url: attempt.url,
            },
            {
              enableWorker: true,
              enableStashBuffer: false,
            }
          );
          mpegtsPlayer.attachMediaElement(video);
          mpegtsPlayer.load();
          safePlayVideo();

          mpegtsPlayer.on(mpegts.Events.ERROR, () => {
            if (!isMounted || myToken !== attemptToken) return;
            if (hasPlaybackStarted && reconnectRetries < 4) {
              reconnectRetries += 1;
              setIsLoading(true);
              reconnectTimer = window.setTimeout(() => {
                if (!isMounted || myToken !== attemptToken) return;
                runAttempt(currentAttemptIdx, lastKnownTimestamp);
              }, 1000);
              return;
            }
            advanceToNextAttempt(myToken);
          });
        } else {
          video.src = attempt.url;
          video.load();
          if (attempt.url.includes('/api/transcode')) {
            window.setTimeout(() => {
              if (isMounted && myToken === attemptToken) {
                requestProbeDuration();
              }
            }, 1200);
          }
          safePlayVideo();
        }
      }, 45);
    };

    const performSeek = (targetSec: number) => {
      if (!isMounted) return;
      clearSeekFallbackTimer();
      clearWaitingWatchdog();

      const safeTarget = Math.max(0, targetSec);
      lastKnownTimestamp = safeTarget;
      reconnectRetries = 0;
      userPausedRef.current = false;
      setHasError(false);
      setIsPlaying(true);

      const activeAttempt = attempts[currentAttemptIdx];
      const currentSrc = video.src || activeAttempt?.url || '';
      const isCurrentlyTranscoding =
        currentSrc.includes('/api/transcode') ||
        Boolean(activeAttempt?.url.includes('/api/transcode'));

      // 1. If already playing via FFmpeg transcode, seek via server-side FFmpeg -ss
      if (isCurrentlyTranscoding) {
        startTranscodeAt(safeTarget);
        return;
      }

      // 2. If playing via mpegts.js, switch to FFmpeg transcode to seek
      if (activeAttempt?.mode === 'mpegts' && mpegtsPlayer) {
        startTranscodeAt(safeTarget);
        return;
      }

      // 3. If playing via Hls.js on a VOD stream, seek natively within Hls.js first
      if (activeAttempt?.mode === 'hls' && hls) {
        seekBaseOffsetRef.current = 0;
        setIsLoading(true);
        try {
          video.currentTime = safeTarget;
          hls.startLoad(safeTarget);
        } catch {
          startTranscodeAt(safeTarget);
          return;
        }
        safePlayVideo();
        const tokenAtSeek = attemptToken;
        seekFallbackTimer = window.setTimeout(() => {
          seekFallbackTimer = null;
          if (!isMounted || tokenAtSeek !== attemptToken) return;
          if (Math.abs(video.currentTime - safeTarget) > 18 && !video.seeking) {
            startTranscodeAt(safeTarget);
          }
        }, 6000);
        return;
      }

      // 4. Native HTML5 <video> playback (/api/proxy or direct MP4/WebM/MKV)
      // Always attempt native browser seeking first so direct VOD streams on GitHub Pages work without /api/transcode!
      seekBaseOffsetRef.current = 0;
      setIsLoading(true);
      try {
        video.currentTime = safeTarget;
      } catch {
        if (canUseBackendProxy()) {
          startTranscodeAt(safeTarget);
        }
        return;
      }
      safePlayVideo();

      const tokenAtSeek = attemptToken;
      seekFallbackTimer = window.setTimeout(() => {
        seekFallbackTimer = null;
        if (!isMounted || tokenAtSeek !== attemptToken) return;
        const currentSrcNow = video.src || '';
        if (currentSrcNow.includes('/api/transcode') || !canUseBackendProxy()) return;

        // If the browser snapped currentTime back (e.g. upstream ignored Range header), fall back to /api/transcode
        if (!video.seeking && Math.abs(video.currentTime - safeTarget) > 14) {
          startTranscodeAt(safeTarget);
          return;
        }

        // If still stuck seeking after 7.5s, fall back to /api/transcode
        if (video.seeking) {
          seekFallbackTimer = window.setTimeout(() => {
            seekFallbackTimer = null;
            if (!isMounted || tokenAtSeek !== attemptToken || !canUseBackendProxy()) return;
            if (video.seeking || Math.abs(video.currentTime - safeTarget) > 14) {
              startTranscodeAt(safeTarget);
            }
          }, 6000);
        }
      }, 2200);
    };

    playerControlRef.current = { seekTo: performSeek };

    const confirmOrWatchVideoTrack = () => {
      if (!isMounted || isTransitioning) return;
      const activeAttempt = attempts[currentAttemptIdx];
      const currentSrc = video.src || activeAttempt?.url || '';
      const isTranscodeAttempt =
        currentSrc.includes('/api/transcode') ||
        Boolean(activeAttempt?.url.includes('/api/transcode'));
      const isStreamingEngine =
        activeAttempt?.mode === 'hls' || activeAttempt?.mode === 'mpegts';
      const hasVideoDimensions = video.videoWidth > 0 && video.videoHeight > 0;

      if (hasVideoDimensions || isTranscodeAttempt || isStreamingEngine) {
        hasPlaybackStarted = true;
        reconnectRetries = 0;
        clearWaitingWatchdog();
        if (stallTimer !== null) {
          window.clearTimeout(stallTimer);
          stallTimer = null;
        }
        if (hasVideoDimensions && noVideoTimer !== null) {
          window.clearTimeout(noVideoTimer);
          noVideoTimer = null;
        }
        setHasError(false);
        setIsLoading(false);
        if (!userPausedRef.current) {
          setIsPlaying(true);
        }

        // If a native or streaming container plays audio for 3.2s with 0x0 video dimensions (e.g. HEVC/MPEG-2 in MP4/MKV/TS),
        // switch to an H.264 level, next MP4 variant, or FFmpeg H.264 transcode so video is never missing!
        if (!hasVideoDimensions && !isTranscodeAttempt && noVideoTimer === null) {
          const tokenAtStart = attemptToken;
          noVideoTimer = window.setTimeout(() => {
            noVideoTimer = null;
            if (!isMounted || isTransitioning || tokenAtStart !== attemptToken) return;
            if ((video.videoWidth === 0 || video.videoHeight === 0) && video.currentTime > 0.8) {
              if (activeAttempt?.mode === 'hls' && hls && hls.levels && hls.levels.length > 1) {
                const altLevelIdx = hls.levels.findIndex(
                  (lvl, idx) =>
                    idx !== hls?.currentLevel &&
                    ((lvl.width && lvl.width > 0) ||
                      /avc1/i.test(`${lvl.videoCodec || ''} ${lvl.attrs?.CODECS || ''}`))
                );
                if (altLevelIdx !== -1) {
                  hls.currentLevel = altLevelIdx;
                  return;
                }
              }
              jumpToTranscodeOrNext(tokenAtStart);
            }
          }, 3200);
        }
        return;
      }

      // Audio/metadata started on a native non-transcode attempt, but videoWidth is still 0.
      // Wait up to 2800ms for video dimensions; if still 0, switch to next MP4 variant or FFmpeg H.264 transcoding.
      if (noVideoTimer === null) {
        const tokenAtStart = attemptToken;
        noVideoTimer = window.setTimeout(() => {
          noVideoTimer = null;
          if (!isMounted || isTransitioning || tokenAtStart !== attemptToken) return;
          if (video.videoWidth === 0 || video.videoHeight === 0) {
            jumpToTranscodeOrNext(tokenAtStart);
          } else {
            confirmOrWatchVideoTrack();
          }
        }, 2800);
      }
    };

    const handlePlaying = () => {
      if (!isMounted || isTransitioning) return;
      clearWaitingWatchdog();
      confirmOrWatchVideoTrack();
    };

    const handleResize = () => {
      if (!isMounted || isTransitioning) return;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        confirmOrWatchVideoTrack();
      }
    };

    const scheduleWaitingReconnectWatchdog = () => {
      if (!isMounted || isTransitioning || !hasPlaybackStarted || userPausedRef.current) return;
      clearWaitingWatchdog();
      const tokenAtWait = attemptToken;
      const timeAtWait = lastKnownTimestamp;
      waitingWatchdogTimer = window.setTimeout(() => {
        waitingWatchdogTimer = null;
        if (!isMounted || isTransitioning || tokenAtWait !== attemptToken || userPausedRef.current) {
          return;
        }
        const nowEffective = seekBaseOffsetRef.current + video.currentTime;
        const isStillStuck = Math.abs(nowEffective - timeAtWait) < 0.4 || video.readyState < 3;
        if (isStillStuck && reconnectRetries < 6) {
          reconnectRetries += 1;
          const savedTime = Math.max(timeAtWait, nowEffective);
          setHasError(false);
          setIsLoading(true);
          const activeAttempt = attempts[currentAttemptIdx];
          if (activeAttempt?.mode === 'hls' && hls && reconnectRetries <= 2) {
            hls.startLoad(savedTime > 1 ? savedTime : -1);
            safePlayVideo();
          } else if (savedTime > 1 || (knownVodDurationRef.current && knownVodDurationRef.current > 0)) {
            startTranscodeAt(savedTime);
          } else {
            runAttempt(currentAttemptIdx, 0);
          }
        }
      }, 9000);
    };

    const handleWaiting = () => {
      if (!isMounted || isTransitioning) return;
      setIsLoading(true);
      scheduleWaitingReconnectWatchdog();
    };

    const handleEnded = () => {
      if (!isMounted || isTransitioning) return;
      const effectiveDur = knownVodDurationRef.current || duration || 0;
      const effectiveNow = seekBaseOffsetRef.current + video.currentTime;
      // If a VOD stream (especially chunked /api/transcode) ended more than 15s before its actual duration,
      // the upstream connection dropped prematurely — automatically reconnect at effectiveNow!
      if (effectiveDur > 30 && effectiveNow < effectiveDur - 15 && reconnectRetries < 6) {
        reconnectRetries += 1;
        setHasError(false);
        setIsLoading(true);
        startTranscodeAt(effectiveNow);
      }
    };

    const handleVideoError = () => {
      if (!isMounted || isTransitioning) return;
      const activeAttempt = attempts[currentAttemptIdx];
      // When Hls.js or mpegts.js is active, their own error listeners handle fallback
      if (activeAttempt?.mode === 'hls' && hls) return;
      if (activeAttempt?.mode === 'mpegts' && mpegtsPlayer) return;

      const currentSrc = video.src || activeAttempt?.url || '';
      const isTranscode = currentSrc.includes('/api/transcode');

      // If a transcode attempt failed before starting playback, try any remaining direct/native attempt
      if (isTranscode && !hasPlaybackStarted) {
        const nextDirectIdx = attempts.findIndex(
          (a, i) => i > currentAttemptIdx && !a.url.includes('/api/transcode')
        );
        if (nextDirectIdx !== -1) {
          runAttempt(nextDirectIdx, lastKnownTimestamp);
          return;
        }
        const anyDirectIdx = attempts.findIndex((a) => a.isDirect && a.mode === 'native');
        if (anyDirectIdx !== -1 && anyDirectIdx !== currentAttemptIdx && reconnectRetries === 0) {
          reconnectRetries += 1;
          runAttempt(anyDirectIdx, lastKnownTimestamp);
          return;
        }
      }

      if ((hasPlaybackStarted || lastKnownTimestamp > 1) && reconnectRetries < 5) {
        reconnectRetries += 1;
        const savedTime = lastKnownTimestamp;
        setHasError(false);
        setIsLoading(true);
        if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(() => {
          if (!isMounted) return;

          // If backend proxy/transcode is available and direct playback failed mid-stream:
          if (canUseBackendProxy() && (isTranscode || reconnectRetries >= 2)) {
            startTranscodeAt(savedTime);
            return;
          }

          // Reload active URL (direct or proxy) and restore savedTime
          seekBaseOffsetRef.current = 0;
          const targetReloadUrl = activeAttempt?.isDirect ? activeAttempt.url : proxyUrl;
          const sep = targetReloadUrl.includes('?') ? '&' : '?';
          video.src = `${targetReloadUrl}${sep}_rc=${Date.now()}`;
          video.load();
          if (savedTime > 1) {
            const onMeta = () => {
              if (!isMounted) return;
              try {
                video.currentTime = savedTime;
              } catch {
                if (canUseBackendProxy()) {
                  startTranscodeAt(savedTime);
                }
                return;
              }
              safePlayVideo();
            };
            video.addEventListener('loadedmetadata', onMeta, { once: true });
          } else {
            safePlayVideo();
          }
        }, 1000);
        return;
      }

      advanceToNextAttempt(attemptToken);
    };

    const handleTimeUpdate = () => {
      if (isTransitioning) return;
      const effectiveTime = seekBaseOffsetRef.current + video.currentTime;
      if (video.currentTime > 0.2) {
        clearWaitingWatchdog();
      }
      lastKnownTimestamp = effectiveTime;
      if (!isScrubbingRef.current) {
        setCurrentTime(effectiveTime);
      }
      if (
        video.duration &&
        Number.isFinite(video.duration) &&
        video.duration > 0
      ) {
        const bestDur = Math.max(
          knownVodDurationRef.current || 0,
          seekBaseOffsetRef.current + video.duration
        );
        knownVodDurationRef.current = bestDur;
        setIsLiveStream(false);
        setDuration(bestDur);
      } else if (knownVodDurationRef.current && knownVodDurationRef.current > 0) {
        setIsLiveStream(false);
        setDuration(knownVodDurationRef.current);
      }
    };

    const handleLoadedMetadata = () => {
      if (!isMounted || isTransitioning) return;
      if (pendingInitialSeekSec > 0 && !video.src.includes('/api/transcode')) {
        const target = pendingInitialSeekSec;
        pendingInitialSeekSec = 0;
        try {
          video.currentTime = target;
        } catch {
          // ignore
        }
      }
      if (
        video.duration &&
        Number.isFinite(video.duration) &&
        video.duration > 0
      ) {
        const bestDur = Math.max(
          knownVodDurationRef.current || 0,
          seekBaseOffsetRef.current + video.duration
        );
        knownVodDurationRef.current = bestDur;
        setIsLiveStream(false);
        setDuration(bestDur);
      } else if (knownVodDurationRef.current && knownVodDurationRef.current > 0) {
        setIsLiveStream(false);
        setDuration(knownVodDurationRef.current);
      } else {
        setIsLiveStream(true);
      }
      confirmOrWatchVideoTrack();
    };

    const handleDurationChange = () => {
      if (!isMounted || isTransitioning) return;
      if (
        video.duration &&
        Number.isFinite(video.duration) &&
        video.duration > 0
      ) {
        const bestDur = Math.max(
          knownVodDurationRef.current || 0,
          seekBaseOffsetRef.current + video.duration
        );
        knownVodDurationRef.current = bestDur;
        setIsLiveStream(false);
        setDuration(bestDur);
      }
    };

    const handleNetworkOnline = () => {
      if (!isMounted || userPausedRef.current) return;
      reconnectRetries = 0;
      if (hasError || video.error || video.readyState < 3) {
        setHasError(false);
        setIsLoading(true);
        if (lastKnownTimestamp > 1) {
          startTranscodeAt(lastKnownTimestamp);
        } else {
          runAttempt(0);
        }
      }
    };

    video.addEventListener('playing', handlePlaying);
    video.addEventListener('canplay', handlePlaying);
    video.addEventListener('resize', handleResize);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('stalled', handleWaiting);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleVideoError);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('durationchange', handleDurationChange);
    window.addEventListener('online', handleNetworkOnline);

    // Start playback (resolving Archive.org / truncated VOD URLs client-side if needed)
    const needsClientVodResolution =
      /^https?:\/\/(?:www\.)?archive\.org\/(?:details|download)\//i.test(cleanUrl) ||
      ((isExplicitNativeVod || isMkvAviOrLegacyContainer) &&
        !/\.(mp4|mkv|m3u8|ts|webm|avi|mov|m4v|flv|ogg)(\?|$)/i.test(cleanUrl));

    const startPlaybackPipeline = async () => {
      await ensureBackendProbed();
      if (!isMounted) return;

      // Refresh proxyUrl and transcodeFullUrl in case ensureBackendProbed resolved a remote backend URL
      const resolvedBase = getEffectiveApiBaseUrl();
      proxyUrl = buildProxyUrl(normalizedChannel, userAgent, undefined, resolvedBase);
      transcodeFullUrl = buildTranscodeUrl(
        normalizedChannel,
        'full',
        0,
        userAgent,
        undefined,
        resolvedBase
      );
      if (resolvedBase) {
        for (const att of attempts) {
          if (att.url.startsWith('/api/')) {
            att.url = `${resolvedBase}${att.url}`;
          }
        }
      }

      if (needsClientVodResolution) {
        const resolvedUrls = await resolveClientSideVodUrls(
          normalizedChannel,
          probeController.signal
        );
        if (!isMounted) return;
        for (let i = resolvedUrls.length - 1; i >= 0; i--) {
          const rUrl = resolvedUrls[i];
          if (rUrl && rUrl !== cleanUrl) {
            if (canUseBackendProxy()) {
              attempts.unshift({
                mode: 'native',
                url: buildProxyUrl(normalizedChannel, userAgent, rUrl, resolvedBase),
              });
            }
            const safeResolvedList = getHttpsSafeMediaUrls(rUrl);
            for (let j = safeResolvedList.length - 1; j >= 0; j--) {
              attempts.unshift({
                mode: 'native',
                url: safeResolvedList[j],
                isDirect: true,
              });
            }
          }
        }
      }

      // Skip initial proxy/transcode attempts if no backend proxy is available
      let firstIdx = 0;
      while (
        firstIdx < attempts.length &&
        !canUseBackendProxy() &&
        (attempts[firstIdx].url.includes('/api/proxy') ||
          attempts[firstIdx].url.includes('/api/transcode'))
      ) {
        firstIdx += 1;
      }

      runAttempt(firstIdx);

      // Delay duration probe by 1800ms so native <video> metadata can populate duration first
      // without opening a competing upstream connection on 1-connection-limit VOD servers!
      window.setTimeout(() => {
        if (isMounted && !knownVodDurationRef.current) {
          requestProbeDuration();
        }
      }, 1800);
    };

    startPlaybackPipeline();

    return () => {
      isMounted = false;
      playerControlRef.current = null;
      probeController.abort();
      clearTimers();
      destroyPlayers();
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('canplay', handlePlaying);
      video.removeEventListener('resize', handleResize);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('stalled', handleWaiting);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('error', handleVideoError);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('durationchange', handleDurationChange);
      window.removeEventListener('online', handleNetworkOnline);
    };
  }, [channel]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      userPausedRef.current = true;
      video.pause();
      setIsPlaying(false);
    } else {
      userPausedRef.current = false;
      video.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  const seekToTime = (targetTime: number) => {
    const effectiveDuration = knownVodDurationRef.current || duration;
    if (!effectiveDuration || effectiveDuration <= 0) return;
    const clampedTime = Math.min(effectiveDuration, Math.max(0, targetTime));
    setCurrentTime(clampedTime);
    setScrubTime(clampedTime);
    if (playerControlRef.current) {
      playerControlRef.current.seekTo(clampedTime);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    seekToTime(Number(e.target.value));
  };

  const handlePrevChannel = () => {
    if (channels.length <= 1) return;
    const prevIdx = (currentIndex - 1 + channels.length) % channels.length;
    onSelectChannel(channels[prevIdx]);
  };

  const handleNextChannel = () => {
    if (channels.length <= 1) return;
    const nextIdx = (currentIndex + 1) % channels.length;
    onSelectChannel(channels[nextIdx]);
  };

  const handleRotateOrAspect = () => {
    setAspectMode((prev) =>
      prev === 'fill' ? 'contain' : prev === 'contain' ? 'cover' : 'fill'
    );
  };

  useEffect(() => {
    return () => {
      if (gestureHudTimeoutRef.current) {
        window.clearTimeout(gestureHudTimeoutRef.current);
      }
    };
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (
      showChannelDrawer ||
      showPlayerSettings ||
      showMoreMenu ||
      isScreenLocked
    ) {
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target && target.closest('button, input, [data-seek-bar="true"]')) {
      return;
    }
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const side: 'left' | 'right' =
      e.clientX - rect.left < rect.width / 2 ? 'left' : 'right';

    gestureStateRef.current = {
      active: true,
      moved: false,
      side,
      startY: e.clientY,
      startBrightness: brightness,
      startVolume: volume,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = gestureStateRef.current;
    if (!state.active) return;

    const deltaY = state.startY - e.clientY; // positive when dragging bottom-to-top
    if (!state.moved && Math.abs(deltaY) < 6) {
      return;
    }

    if (!state.moved) {
      state.moved = true;
      setShowControls(false);
    }

    if (gestureHudTimeoutRef.current) {
      window.clearTimeout(gestureHudTimeoutRef.current);
      gestureHudTimeoutRef.current = null;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    const height = rect && rect.height > 0 ? rect.height : window.innerHeight || 400;
    const effectiveRangePx = Math.max(160, height * 0.65);

    if (state.side === 'left') {
      const deltaPercent = (deltaY / effectiveRangePx) * 100;
      const nextBrightness = Math.round(
        Math.min(100, Math.max(0, state.startBrightness + deltaPercent))
      );
      setBrightness(nextBrightness);
      setGestureHud('brightness');
    } else {
      const deltaPercent = (deltaY / effectiveRangePx) * 200;
      const nextVolume = Math.round(
        Math.min(200, Math.max(0, state.startVolume + deltaPercent))
      );
      setVolume(nextVolume);
      setGestureHud('volume');

      if (videoRef.current) {
        videoRef.current.volume = Math.min(1, Math.max(0, nextVolume / 100));
        videoRef.current.muted = nextVolume === 0;
      }
    }
  };

  const handlePointerEnd = () => {
    const state = gestureStateRef.current;
    if (!state.active) return;
    state.active = false;

    if (state.moved) {
      suppressNextClickRef.current = true;
      if (gestureHudTimeoutRef.current) {
        window.clearTimeout(gestureHudTimeoutRef.current);
      }
      gestureHudTimeoutRef.current = window.setTimeout(() => {
        setGestureHud(null);
      }, 1100);
    }
  };

  const effectiveDisplayTime = isScrubbing ? scrubTime : currentTime;
  const progressPercent =
    !isLiveStream && duration && duration > 0
      ? Math.min(100, Math.max(0, (effectiveDisplayTime / duration) * 100))
      : 0;

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onClick={() => {
        if (suppressNextClickRef.current) {
          suppressNextClickRef.current = false;
          return;
        }
        setShowControls((prev) => !prev);
      }}
      className="fixed inset-0 z-50 bg-black flex flex-col justify-between select-none overflow-hidden touch-none"
    >
      {/* HTML5 Video Element (kept free of CSS filter so hardware video overlays never black out) */}
      <video
        ref={videoRef}
        style={
          videoScale !== 100
            ? { transform: `scale(${videoScale / 100})` }
            : undefined
        }
        className={`absolute inset-0 w-full h-full transition-transform duration-75 ${
          aspectRatioIdx === 3
            ? 'object-fill'
            : aspectRatioIdx === 1 || aspectRatioIdx === 2
            ? 'object-cover'
            : aspectMode === 'fill'
            ? 'object-fill'
            : aspectMode === 'cover'
            ? 'object-cover'
            : 'object-contain'
        }`}
        playsInline
        autoPlay
      />

      {/* Hardware-safe Brightness Dimming Overlay */}
      {brightness < 92 && (
        <div
          className="absolute inset-0 pointer-events-none z-[5]"
          style={{
            backgroundColor: `rgba(0, 0, 0, ${Math.min(0.82, ((92 - brightness) / 92) * 0.82)})`,
          }}
        />
      )}

      {/* =====================================================================
          CENTER LOADING INDICATOR OR ERROR MESSAGE
          Matches Screenshot 7 ("Loading...") & Screenshot_20261009-215505_IPTV.jpg ("Error playing channel")
         ===================================================================== */}
      {hasError ? (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 px-6">
          <span className="text-[18.5px] font-normal text-white tracking-[0.01em] text-center">
            Error playing channel
          </span>
        </div>
      ) : (
        isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10">
            <svg
              className="w-12 h-12 animate-spin text-[#5BAAF5]"
              viewBox="0 0 50 50"
              aria-hidden="true"
            >
              <circle
                cx="25"
                cy="25"
                r="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="butt"
                strokeDasharray="80 120"
              />
            </svg>
            <span className="mt-2.5 text-[14.5px] font-normal text-[#B0B0B0] tracking-[0.01em]">
              Loading...
            </span>
          </div>
        )
      )}

      {/* =====================================================================
          TOP OVERLAY AREA (Row 1: Back Arrow + Star/Cast/More; Row 2: Logo + Name)
         ===================================================================== */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`relative z-20 flex flex-col bg-gradient-to-b from-black/70 via-black/25 to-transparent pb-6 transition-opacity duration-200 ${
          showControls && !showPlayerSettings && !showChannelDrawer
            ? 'opacity-100'
            : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Row 1: Top Action Bar */}
        <div className="h-14 px-2 flex items-center justify-between">
          <button
            onClick={onClose}
            className="w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
            aria-label="Back"
          >
            <ArrowLeft className="w-6 h-6 stroke-[2] drop-shadow" />
          </button>

          <div className="flex items-center gap-0.5">
            {/* 1. Favorite Star Icon */}
            <button
              onClick={() => onToggleFavorite(channel.id)}
              className="w-11 h-11 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
              aria-label="Favorite"
            >
              <Star
                className={`w-[22px] h-[22px] stroke-[2] drop-shadow ${
                  isFavorite ? 'fill-[#FFD54F] text-[#FFD54F]' : 'text-white'
                }`}
              />
            </button>

            {/* 2. Cast Icon */}
            <button
              onClick={() => {}}
              className="w-11 h-11 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
              aria-label="Cast"
            >
              <svg
                viewBox="0 0 24 24"
                className="w-[22px] h-[22px] fill-current drop-shadow"
                aria-hidden="true"
              >
                <path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z" />
              </svg>
            </button>

            {/* 3. Three Vertical Dots Icon */}
            <button
              onClick={() => setShowMoreMenu((prev) => !prev)}
              className="w-11 h-11 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
              aria-label="More options"
            >
              <MoreVertical className="w-[22px] h-[22px] drop-shadow" />
            </button>
          </div>
        </div>

        {/* Row 2: Channel Logo + Channel Title directly below Back Arrow */}
        <div className="px-5 pt-0.5 flex items-center gap-4">
          {channel.logo && !logoError ? (
            <div className="w-12 h-12 rounded-[2px] overflow-hidden shrink-0 flex items-center justify-center">
              <img
                src={channel.logo}
                alt={channel.name}
                referrerPolicy="no-referrer"
                onError={() => setLogoError(true)}
                className="w-full h-full object-contain"
              />
            </div>
          ) : isFavChannelTitle ? (
            /* Exact circular dark badge with yellow heart from Screenshot 10 ("ZEE TV FAV") */
            <div className="w-11 h-11 rounded-full bg-black/45 border border-white/15 flex items-center justify-center shrink-0">
              <svg
                viewBox="0 0 24 24"
                className="w-6 h-6 fill-[#FBC02D]"
                aria-hidden="true"
              >
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
              </svg>
            </div>
          ) : (
            <div className="w-12 h-12 rounded-[2px] bg-[#242424] flex items-center justify-center shrink-0">
              <span className="text-xs font-semibold text-[#BDBDBD] uppercase">
                {channel.name.slice(0, 3)}
              </span>
            </div>
          )}

          <h2 className="text-[20px] font-medium text-white tracking-normal truncate drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
            {channel.name}
          </h2>
        </div>
      </div>

      {/* =====================================================================
          BOTTOM CONTROLS + PROGRESS BAR OVERLAY
          Matches both Screenshot 9 (VOD: "00:15 ●———— 1:08:24")
          and Screenshot 10 (LIVE: "00:07 ————— LIVE")
         ===================================================================== */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`relative z-20 w-full flex flex-col bg-gradient-to-t from-black/80 via-black/35 to-transparent pt-6 pb-2.5 transition-opacity duration-200 ${
          showControls && !showPlayerSettings && !showChannelDrawer
            ? 'opacity-100'
            : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Row 1: 5 Evenly Spaced Controls */}
        <div className="w-full grid grid-cols-5 items-center justify-items-center pb-2">
          {/* 1. Hamburger Channel List Button (☰) */}
          <button
            onClick={() => {
              setDrawerCategory('All Channels');
              setDrawerView('channels');
              setShowControls(false);
              setShowChannelDrawer(true);
            }}
            className="w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
            aria-label="Channel list"
          >
            <svg
              viewBox="0 0 24 24"
              className="w-6 h-6 fill-current drop-shadow"
              aria-hidden="true"
            >
              <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
            </svg>
          </button>

          {/* 2. Previous Channel Button (|◀) */}
          <button
            onClick={handlePrevChannel}
            className="w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
            aria-label="Previous channel"
          >
            <svg
              viewBox="0 0 24 24"
              className="w-6 h-6 fill-current drop-shadow"
              aria-hidden="true"
            >
              <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
            </svg>
          </button>

          {/* 3. Center Pause (||) / Play (▶) Button */}
          <button
            onClick={togglePlay}
            className="w-14 h-14 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <svg
                viewBox="0 0 24 24"
                className="w-9 h-9 fill-current drop-shadow"
                aria-hidden="true"
              >
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                className="w-9 h-9 fill-current drop-shadow"
                aria-hidden="true"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          {/* 4. Next Channel Button (▶|) */}
          <button
            onClick={handleNextChannel}
            className="w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
            aria-label="Next channel"
          >
            <svg
              viewBox="0 0 24 24"
              className="w-6 h-6 fill-current drop-shadow"
              aria-hidden="true"
            >
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
            </svg>
          </button>

          {/* 5. Screen Rotation / Aspect Mode Icon */}
          <button
            onClick={handleRotateOrAspect}
            className="w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:bg-white/20 transition-colors"
            aria-label="Rotate or change aspect ratio"
          >
            <svg
              viewBox="0 0 24 24"
              className="w-6 h-6 fill-current drop-shadow"
              aria-hidden="true"
            >
              <path d="M16.48 2.52c3.27 1.55 5.61 4.72 5.97 8.48h1.5C23.44 4.84 18.29 0 12 0l-.66.03 3.81 3.81 1.33-1.32zm-6.25-.77c-.59-.59-1.54-.59-2.12 0L1.75 8.11c-.59.59-.59 1.54 0 2.12l12.02 12.02c.59.59 1.54.59 2.12 0l6.36-6.36c.59-.59.59-1.54 0-2.12L10.23 1.75zm4.6 19.44L2.81 9.17l6.36-6.36 12.02 12.02-6.36 6.36zm-7.31.29C4.25 19.94 1.91 16.76 1.55 13H.05C.56 19.16 5.71 24 12 24l.66-.03-3.81-3.81-1.33 1.32z" />
            </svg>
          </button>
        </div>

        {/* Row 2: Progress / Live Timeline Bar */}
        <div
          data-seek-bar="true"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="w-full px-4 flex items-center gap-3"
        >
          <span className="text-[12.5px] font-medium text-white tabular-nums drop-shadow shrink-0">
            {formatDuration(effectiveDisplayTime)}
          </span>

          <div
            onPointerDown={(e) => {
              e.stopPropagation();
              const effectiveDuration = knownVodDurationRef.current || duration;
              if (isLiveStream || !effectiveDuration || effectiveDuration <= 0) return;
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                // ignore
              }
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio =
                rect.width > 0
                  ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
                  : 0;
              const nextTime = ratio * effectiveDuration;
              isScrubbingRef.current = true;
              setIsScrubbing(true);
              setScrubTime(nextTime);
            }}
            onPointerMove={(e) => {
              e.stopPropagation();
              if (!isScrubbingRef.current) return;
              const effectiveDuration = knownVodDurationRef.current || duration;
              if (!effectiveDuration || effectiveDuration <= 0) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio =
                rect.width > 0
                  ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
                  : 0;
              setScrubTime(ratio * effectiveDuration);
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              if (!isScrubbingRef.current) return;
              try {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                }
              } catch {
                // ignore
              }
              const effectiveDuration = knownVodDurationRef.current || duration;
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio =
                rect.width > 0
                  ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
                  : 0;
              isScrubbingRef.current = false;
              setIsScrubbing(false);
              if (effectiveDuration && effectiveDuration > 0) {
                seekToTime(ratio * effectiveDuration);
              }
            }}
            onPointerCancel={(e) => {
              e.stopPropagation();
              isScrubbingRef.current = false;
              setIsScrubbing(false);
            }}
            className="relative flex-1 h-7 flex items-center cursor-pointer touch-none"
          >
            {/* Base Track */}
            <div className="w-full h-[3px] bg-white/35 rounded-full overflow-hidden">
              {!isLiveStream && (
                <div
                  className="h-full bg-[#5BAAF5]"
                  style={{ width: `${progressPercent}%` }}
                />
              )}
            </div>

            {/* Sky-Blue Circular Thumb (only shown on seekable VOD streams, hidden on LIVE streams as in Screenshot 10) */}
            {!isLiveStream && (
              <div
                className={`absolute rounded-full bg-[#5BAAF5] shadow pointer-events-none -translate-x-1/2 transition-transform ${
                  isScrubbing ? 'w-4 h-4 scale-110' : 'w-3.5 h-3.5'
                }`}
                style={{ left: `${progressPercent}%` }}
              />
            )}
          </div>

          <span className="text-[12.5px] font-medium text-white tabular-nums drop-shadow shrink-0 uppercase">
            {isLiveStream || !duration ? 'LIVE' : formatDuration(duration)}
          </span>
        </div>
      </div>

      {/* Top-Right Clock ("12:42 PM") shown when Channel Drawer is open, Gesture HUD is active, or Clock setting enabled — Exact Match to 1.jpg & 2.jpg */}
      {(showChannelDrawer ||
        gestureHud !== null ||
        showClockIdx === 2 ||
        (showClockIdx === 1 && showControls)) && (
        <div className="fixed top-1.5 right-3.5 z-30 pointer-events-none">
          <span className="text-[18.5px] font-normal text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
            {clockText}
          </span>
        </div>
      )}

      {/* =====================================================================
          CENTER BRIGHTNESS & VOLUME GESTURE HUD OVERLAY
          Exact Match to 1.jpg ("Brightness 92%") and 2.jpg ("Volume 127%")
         ===================================================================== */}
      {gestureHud !== null && (
        <div className="fixed inset-0 z-30 flex items-center justify-center pointer-events-none">
          <div className="bg-black/45 rounded-[3px] px-2.5 py-2 flex items-center gap-3.5 min-w-[164px] shadow-[0_2px_10px_rgba(0,0,0,0.45)]">
            {/* Left Vertical Progress Bar */}
            <div className="w-[14px] h-[68px] border border-[#A0A0A0]/80 bg-black/75 p-[1px] flex flex-col justify-end overflow-hidden shrink-0">
              {gestureHud === 'brightness' ? (
                <div
                  className="w-full bg-[#72C7F5]"
                  style={{ height: `${brightness}%` }}
                />
              ) : volume <= 100 ? (
                <div
                  className="w-full bg-[#72C7F5]"
                  style={{ height: `${volume}%` }}
                />
              ) : (
                <div className="w-full h-full flex flex-col">
                  <div
                    className="w-full bg-[#72C7F5]"
                    style={{ height: `${200 - volume}%` }}
                  />
                  <div
                    className="w-full bg-[#C82829]"
                    style={{ height: `${volume - 100}%` }}
                  />
                </div>
              )}
            </div>

            {/* Right Centered Two-Line Label + Percentage */}
            <div className="flex-1 flex flex-col items-center justify-center pr-1">
              <span className="text-[21px] font-normal text-white leading-[1.22] tracking-normal drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
                {gestureHud === 'brightness' ? 'Brightness' : 'Volume'}
              </span>
              <span className="text-[21px] font-normal text-white leading-[1.22] tracking-normal drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
                {gestureHud === 'brightness' ? `${brightness}%` : `${volume}%`}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          LEFT TRANSLUCENT CHANNEL LIST OVERLAY IN PLAYER
          Exact Match to Screenshot_20261010-123420_IPTV.jpg
          (Header: "< |LATEST MOVIES|", translucent rows over live video,
           active channel highlighted in semi-transparent sky-blue #3897D3/75
           with bottom progress bar)
         ===================================================================== */}
      {showChannelDrawer && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setShowChannelDrawer(false);
          }}
          className="fixed inset-0 z-30 bg-transparent flex"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[235px] sm:w-[250px] max-w-[78vw] h-full bg-black/35 flex flex-col select-none"
          >
            {/* Top Category Header Row ("< All Channels") */}
            {drawerView === 'channels' ? (
              <div
                onClick={() => setDrawerView('categories')}
                className="h-[44px] px-3 flex items-center gap-3 border-b border-white/[0.18] cursor-pointer hover:bg-white/10 active:bg-white/15 transition-colors shrink-0"
              >
                <ChevronLeft className="w-5 h-5 text-[#BDBDBD] stroke-[2] shrink-0" />
                <span className="text-[15px] font-normal text-white truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
                  All Channels
                </span>
              </div>
            ) : (
              <div
                onClick={() => setDrawerView('channels')}
                className="h-[44px] px-3 flex items-center gap-3 border-b border-white/[0.18] cursor-pointer hover:bg-white/10 active:bg-white/15 transition-colors shrink-0"
              >
                <ChevronLeft className="w-5 h-5 text-[#BDBDBD] stroke-[2] shrink-0" />
                <span className="text-[15px] font-normal text-white truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
                  All Channels
                </span>
              </div>
            )}

            {/* Scrollable List */}
            <div className="flex-1 overflow-y-auto no-scrollbar divide-y divide-white/[0.18]">
              {drawerView === 'channels'
                ? drawerChannels.map((ch) => {
                    const isActive = ch.id === channel.id;
                    const isFavPlaceholder = /\bFAV\b/i.test(ch.name);
                    return (
                      <div
                        key={ch.id}
                        ref={isActive ? activeDrawerItemRef : null}
                        onClick={() => {
                          setDrawerCategory('All Channels');
                          setDrawerView('channels');
                          onSelectChannel(ch);
                          setShowChannelDrawer(false);
                        }}
                        className={`relative h-[64px] px-1.5 flex items-center gap-2.5 cursor-pointer transition-colors ${
                          isActive
                            ? 'bg-[#3897D3]/75'
                            : 'bg-transparent hover:bg-white/10'
                        }`}
                      >
                        {/* Square Poster / Logo */}
                        {ch.logo ? (
                          <div className="w-[46px] h-[46px] bg-black/40 shrink-0 overflow-hidden flex items-center justify-center">
                            <img
                              src={ch.logo}
                              alt={ch.name}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          </div>
                        ) : isFavPlaceholder ? (
                          <div className="w-[46px] h-[46px] bg-black/35 shrink-0 flex items-center justify-center">
                            <svg
                              viewBox="0 0 24 24"
                              className="w-7 h-7 fill-[#FBC02D]"
                              aria-hidden="true"
                            >
                              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                            </svg>
                          </div>
                        ) : (
                          <div className="w-[46px] h-[46px] bg-[#242424]/80 flex items-center justify-center text-xs text-white shrink-0">
                            {ch.name.slice(0, 3)}
                          </div>
                        )}

                        {/* Channel Title */}
                        <span className="text-[14.5px] font-normal text-white truncate pr-1 drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
                          {ch.name}
                        </span>

                        {/* Bottom Thin Progress Bar on Active Row (matching "Eyes (SOUTH)" in Screenshot) */}
                        {isActive && (
                          <div className="absolute left-[56px] right-2 bottom-1.5 h-[3px] bg-white/30 overflow-hidden">
                            <div
                              className="h-full bg-[#8AD0F8]"
                              style={{
                                width: `${progressPercent > 0 ? progressPercent : 34}%`,
                              }}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })
                : drawerCategories.map((cat) => {
                    const isCatSelected = cat === drawerCategory;
                    return (
                      <div
                        key={cat}
                        onClick={() => {
                          setDrawerCategory(cat);
                          setDrawerView('channels');
                        }}
                        className={`h-[52px] px-3.5 flex items-center cursor-pointer transition-colors ${
                          isCatSelected
                            ? 'bg-[#3897D3]/75'
                            : 'bg-transparent hover:bg-white/10'
                        }`}
                      >
                        <span className="text-[14.5px] font-normal text-white truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
                          {cat}
                        </span>
                      </div>
                    );
                  })}
            </div>
          </div>
        </div>
      )}

      {/* Top-right 3-dots popup menu inside Player — Exact Match to Screenshot_20261009-204112_IPTV.jpg */}
      {showMoreMenu && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setShowMoreMenu(false);
            setShowAccelSubmenu(false);
          }}
          className="fixed inset-0 z-30 bg-transparent"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="fixed top-2 right-2.5 w-[202px] bg-[#303030] rounded-[2px] shadow-[0_6px_18px_rgba(0,0,0,0.75)] py-1 text-white border border-white/[0.04]"
          >
            {!showAccelSubmenu ? (
              <>
                {/* 1. HW+ with right triangle arrow */}
                <button
                  type="button"
                  onClick={() => setShowAccelSubmenu(true)}
                  className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors flex items-center justify-between"
                >
                  <span>{accelMode}</span>
                  <svg
                    viewBox="0 0 24 24"
                    className="w-4 h-4 fill-white shrink-0"
                    aria-hidden="true"
                  >
                    <path d="M10 17l5-5-5-5v10z" />
                  </svg>
                </button>

                {/* 2. Lock screen */}
                <button
                  type="button"
                  onClick={() => {
                    setShowMoreMenu(false);
                    setIsScreenLocked(true);
                    triggerPlayerToast('Screen locked');
                  }}
                  className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                >
                  Lock screen
                </button>

                {/* 3. Sleep timer */}
                <button
                  type="button"
                  onClick={() => {
                    setShowMoreMenu(false);
                    triggerPlayerToast('Sleep timer: Off');
                  }}
                  className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                >
                  Sleep timer
                </button>

                {/* 4. Picture-in-picture mode */}
                <button
                  type="button"
                  onClick={async () => {
                    setShowMoreMenu(false);
                    try {
                      if (
                        videoRef.current &&
                        'requestPictureInPicture' in videoRef.current
                      ) {
                        await (
                          videoRef.current as HTMLVideoElement & {
                            requestPictureInPicture: () => Promise<unknown>;
                          }
                        ).requestPictureInPicture();
                      } else {
                        triggerPlayerToast('Picture-in-picture mode enabled');
                      }
                    } catch {
                      triggerPlayerToast('Picture-in-picture mode');
                    }
                  }}
                  className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                >
                  Picture-in-picture mode
                </button>

                {/* 5. Start recording */}
                <button
                  type="button"
                  onClick={() => {
                    setShowMoreMenu(false);
                    setIsRecording((prev) => {
                      const next = !prev;
                      triggerPlayerToast(
                        next ? 'Recording started' : 'Recording stopped'
                      );
                      return next;
                    });
                  }}
                  className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                >
                  {isRecording ? 'Stop recording' : 'Start recording'}
                </button>

                {/* 6. Settings */}
                <button
                  type="button"
                  onClick={() => {
                    setShowMoreMenu(false);
                    setShowControls(false);
                    setShowPlayerSettings(true);
                  }}
                  className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors"
                >
                  Settings
                </button>
              </>
            ) : (
              /* Submenu for HW / HW+ / SW acceleration modes */
              <>
                {(['HW', 'HW+', 'SW'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setAccelMode(mode);
                      setShowAccelSubmenu(false);
                      setShowMoreMenu(false);
                    }}
                    className="w-full px-4 py-3 text-left text-[15.5px] font-normal text-white hover:bg-white/10 active:bg-white/15 transition-colors flex items-center justify-between"
                  >
                    <span>{mode}</span>
                    {accelMode === mode && (
                      <span className="w-2 h-2 rounded-full bg-[#5BAAF5]" />
                    )}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          CENTER IN-PLAYER SETTINGS OVERLAY
          Exact Match to Screenshot_20261009-204818_IPTV.jpg
          (Brightness: 65%, Aspect ratio: Best Fit, Scale: 100%, Show clock: Never, RESET)
         ===================================================================== */}
      {showPlayerSettings && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setShowPlayerSettings(false);
          }}
          className="fixed inset-0 z-40 flex items-center justify-center bg-transparent"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[340px] max-w-[90vw] bg-black/75 px-8 pt-6 pb-5 text-white shadow-2xl"
          >
            {/* 1. Brightness: 65% */}
            <div className="mb-5">
              <p className="text-[13.5px] font-normal text-[#E0E0E0] text-center mb-3">
                Brightness: {brightness}%
              </p>
              <div className="relative w-full h-4 flex items-center">
                <div className="w-full h-[2.5px] bg-white" />
                <div
                  className="absolute w-[13px] h-[13px] rounded-full bg-[#4EA1F3] shadow pointer-events-none -translate-x-1/2"
                  style={{ left: `${brightness}%` }}
                />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={brightness}
                  onChange={(e) => setBrightness(Number(e.target.value))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>
            </div>

            {/* 2. Aspect ratio: Best Fit */}
            <div className="mb-5">
              <p className="text-[13.5px] font-normal text-[#E0E0E0] text-center mb-3">
                Aspect ratio: {ASPECT_RATIO_LABELS[aspectRatioIdx]}
              </p>
              <div className="relative w-full h-4 flex items-center">
                <div className="w-full h-[2.5px] bg-white" />
                <div
                  className="absolute w-[13px] h-[13px] rounded-full bg-[#4EA1F3] shadow pointer-events-none -translate-x-1/2"
                  style={{
                    left: `${(aspectRatioIdx / (ASPECT_RATIO_LABELS.length - 1)) * 100}%`,
                  }}
                />
                <input
                  type="range"
                  min={0}
                  max={ASPECT_RATIO_LABELS.length - 1}
                  step={1}
                  value={aspectRatioIdx}
                  onChange={(e) => setAspectRatioIdx(Number(e.target.value))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>
            </div>

            {/* 3. Scale: 100% (range 50 to 200 so 100% sits at 1/3 from left as in screenshot) */}
            <div className="mb-5">
              <p className="text-[13.5px] font-normal text-[#E0E0E0] text-center mb-3">
                Scale: {videoScale}%
              </p>
              <div className="relative w-full h-4 flex items-center">
                <div className="w-full h-[2.5px] bg-white" />
                <div
                  className="absolute w-[13px] h-[13px] rounded-full bg-[#4EA1F3] shadow pointer-events-none -translate-x-1/2"
                  style={{
                    left: `${((videoScale - 50) / 150) * 100}%`,
                  }}
                />
                <input
                  type="range"
                  min={50}
                  max={200}
                  step={1}
                  value={videoScale}
                  onChange={(e) => setVideoScale(Number(e.target.value))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>
            </div>

            {/* 4. Show clock: Never */}
            <div className="mb-5">
              <p className="text-[13.5px] font-normal text-[#E0E0E0] text-center mb-3">
                Show clock: {SHOW_CLOCK_LABELS[showClockIdx]}
              </p>
              <div className="relative w-full h-4 flex items-center">
                <div className="w-full h-[2.5px] bg-white" />
                <div
                  className="absolute w-[13px] h-[13px] rounded-full bg-[#4EA1F3] shadow pointer-events-none -translate-x-1/2"
                  style={{
                    left: `${(showClockIdx / (SHOW_CLOCK_LABELS.length - 1)) * 100}%`,
                  }}
                />
                <input
                  type="range"
                  min={0}
                  max={SHOW_CLOCK_LABELS.length - 1}
                  step={1}
                  value={showClockIdx}
                  onChange={(e) => setShowClockIdx(Number(e.target.value))}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>
            </div>

            {/* Bottom-right RESET button */}
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setBrightness(65);
                  setAspectRatioIdx(0);
                  setVideoScale(100);
                  setShowClockIdx(0);
                }}
                className="px-2 py-1 text-[13px] font-medium text-white uppercase tracking-wide hover:bg-white/10 active:bg-white/20 rounded transition-colors"
              >
                RESET
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unlock button when screen is locked */}
      {isScreenLocked && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setIsScreenLocked(false);
            triggerPlayerToast('Screen unlocked');
          }}
          className="fixed top-4 left-4 z-40 w-11 h-11 rounded-full bg-black/60 border border-white/20 flex items-center justify-center text-white cursor-pointer hover:bg-black/80"
          title="Unlock screen"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
            <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
          </svg>
        </div>
      )}

      {/* Subtle Toast inside Player */}
      {playerToast && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-40 bg-[#212121]/90 text-white text-sm px-4 py-2 rounded shadow-lg pointer-events-none">
          {playerToast}
        </div>
      )}
    </div>
  );
};
