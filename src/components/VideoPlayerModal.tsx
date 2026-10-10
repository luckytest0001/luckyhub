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
  isYouTubeChannelUrl,
  openExternalChannelLink,
  repairAndNormalizeChannel,
} from '../utils/playlistParser';

interface VideoPlayerModalProps {
  channel: Channel;
  channels: Channel[];
  allChannels?: Channel[];
  isFavorite: boolean;
  onToggleFavorite: (channelId: string) => void;
  onSelectChannel: (channel: Channel) => void;
  onClose: () => void;
  onOpenSettings?: () => void;
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

function buildProxyUrl(channel: Channel): string {
  let proxy = `/api/proxy?url=${encodeURIComponent(channel.url)}`;
  if (channel.userAgent) {
    proxy += `&ua=${encodeURIComponent(channel.userAgent)}`;
  }
  if (channel.referer) {
    proxy += `&ref=${encodeURIComponent(channel.referer)}`;
  }
  if (channel.name) {
    proxy += `&title=${encodeURIComponent(channel.name)}`;
  }
  return proxy;
}

function buildTranscodeUrl(channel: Channel, mode: 'remux' | 'full', seekSec = 0): string {
  let url = `/api/transcode?mode=${mode}&url=${encodeURIComponent(channel.url)}`;
  if (channel.userAgent) {
    url += `&ua=${encodeURIComponent(channel.userAgent)}`;
  }
  if (channel.referer) {
    url += `&ref=${encodeURIComponent(channel.referer)}`;
  }
  if (channel.name) {
    url += `&title=${encodeURIComponent(channel.name)}`;
  }
  if (seekSec > 0) {
    url += `&ss=${Math.floor(seekSec)}`;
  }
  return url;
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
    let seekBaseOffset = 0;
    let lastKnownTimestamp = 0;
    let reconnectRetries = 0;
    let transitionTimer: number | null = null;
    let stallTimer: number | null = null;
    let noVideoTimer: number | null = null;
    let reconnectTimer: number | null = null;

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
    const mustUseProxyOnly =
      !isHttpProtocol ||
      /^http:\/\//i.test(cleanUrl) ||
      Boolean(normalizedChannel.userAgent) ||
      Boolean(normalizedChannel.referer);

    const isExplicitM3u8 = /\.m3u8(\?|$|#|&)/i.test(cleanUrl);
    const isExplicitTsOrFlv = /\.(ts|flv)(\?|$|#|&)/i.test(cleanUrl);
    const isMkvAviOrLegacyContainer =
      /\.(mkv|avi|flv|wmv|mpg|mpeg|3gp|divx)(\?|$|#|&)/i.test(cleanUrl);

    const proxyUrl = buildProxyUrl(normalizedChannel);
    const transcodeFullUrl = buildTranscodeUrl(normalizedChannel, 'full');

    const attempts: Array<{ mode: 'native' | 'hls' | 'mpegts'; url: string }> = [];

    if (!isHttpProtocol) {
      // RTMP / RTSP / UDP / MMS streams handled via server-side FFmpeg H.264 transcode
      attempts.push({ mode: 'native', url: transcodeFullUrl });
    } else if (isExplicitM3u8) {
      if (!mustUseProxyOnly && Hls.isSupported()) {
        attempts.push({ mode: 'hls', url: cleanUrl });
      }
      if (Hls.isSupported()) {
        attempts.push({ mode: 'hls', url: proxyUrl });
      }
      attempts.push({ mode: 'native', url: transcodeFullUrl });
      attempts.push({ mode: 'native', url: proxyUrl });
    } else if (isExplicitTsOrFlv) {
      if (mpegts.isSupported()) {
        attempts.push({ mode: 'mpegts', url: proxyUrl });
      }
      attempts.push({ mode: 'native', url: transcodeFullUrl });
      if (Hls.isSupported()) {
        attempts.push({ mode: 'hls', url: proxyUrl });
      }
    } else if (isMkvAviOrLegacyContainer) {
      // For .mkv / .avi / .flv VOD movies (often with HEVC/Xvid video or AC3/EAC3 audio):
      // Transcode to universal 8-bit H.264 + stereo AAC first so both video and audio always work
      attempts.push({ mode: 'native', url: transcodeFullUrl });
      attempts.push({ mode: 'native', url: proxyUrl });
      if (!mustUseProxyOnly) {
        attempts.push({ mode: 'native', url: cleanUrl });
      }
    } else {
      // Standard .mp4, .webm, .mov, /movie/, /series/, /vod/, or extensionless URLs
      attempts.push({ mode: 'native', url: proxyUrl });
      attempts.push({ mode: 'native', url: transcodeFullUrl });
      if (!mustUseProxyOnly) {
        attempts.push({ mode: 'native', url: cleanUrl });
      }
      if (Hls.isSupported()) {
        attempts.push({ mode: 'hls', url: proxyUrl });
      }
      if (mpegts.isSupported()) {
        attempts.push({ mode: 'mpegts', url: proxyUrl });
      }
    }

    const safePlayVideo = () => {
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

    const advanceToNextAttempt = (fromToken: number) => {
      if (!isMounted || fromToken !== attemptToken) return;
      runAttempt(currentAttemptIdx + 1);
    };

    const jumpToTranscodeOrNext = (fromToken: number) => {
      if (!isMounted || fromToken !== attemptToken) return;
      const transcodeIdx = attempts.findIndex(
        (a, i) => i > currentAttemptIdx && a.url.includes('/api/transcode')
      );
      if (transcodeIdx !== -1) {
        runAttempt(transcodeIdx);
      } else {
        runAttempt(currentAttemptIdx + 1);
      }
    };

    const runAttempt = (idx: number) => {
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

      // Guard against asynchronous error events fired by detaching previous media sources
      isTransitioning = true;
      destroyPlayers();
      video.removeAttribute('src');
      video.load();

      transitionTimer = window.setTimeout(() => {
        if (!isMounted || myToken !== attemptToken) return;
        isTransitioning = false;

        // Set a safety stall timeout in case this attempt hangs without starting playback
        const timeoutMs = attempt.url.includes('/api/transcode') ? 22000 : 14000;
        stallTimer = window.setTimeout(() => {
          if (!isMounted || myToken !== attemptToken || hasPlaybackStarted) return;
          advanceToNextAttempt(myToken);
        }, timeoutMs);

        if (attempt.mode === 'hls' && Hls.isSupported()) {
          hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 60,
            manifestLoadingTimeOut: 10000,
            manifestLoadingMaxRetry: 1,
            levelLoadingTimeOut: 10000,
          });
          hls.loadSource(attempt.url);
          hls.attachMedia(video);

          hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
            if (!isMounted || myToken !== attemptToken) return;
            const hasUnsupportedVideoCodec =
              Array.isArray(data?.levels) &&
              data.levels.length > 0 &&
              data.levels.every(
                (lvl: { videoCodec?: string; attrs?: { CODECS?: string } }) => {
                  const codecs = `${lvl.videoCodec || ''} ${lvl.attrs?.CODECS || ''}`.toLowerCase();
                  return /hev1|hvc1|hevc|mp4v|mpeg2/i.test(codecs);
                }
              );
            if (hasUnsupportedVideoCodec) {
              jumpToTranscodeOrNext(myToken);
              return;
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
              setDuration(data.details.totalduration);
            }
          });

          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!isMounted || myToken !== attemptToken) return;
            if (data.fatal) {
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMediaError) {
                recoveredMediaError = true;
                hls?.recoverMediaError();
              } else if (hasPlaybackStarted && reconnectRetries < 5) {
                reconnectRetries += 1;
                const savedTime = lastKnownTimestamp;
                setIsLoading(true);
                reconnectTimer = window.setTimeout(() => {
                  if (!isMounted || myToken !== attemptToken) return;
                  hls?.startLoad(savedTime > 1 ? savedTime : -1);
                  safePlayVideo();
                }, 1200);
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
            advanceToNextAttempt(myToken);
          });
        } else {
          video.src = attempt.url;
          video.load();
          safePlayVideo();
        }
      }, 45);
    };

    const confirmOrWatchVideoTrack = () => {
      if (!isMounted || isTransitioning) return;
      const activeAttempt = attempts[currentAttemptIdx];
      const isTranscodeAttempt = Boolean(activeAttempt?.url.includes('/api/transcode'));
      const hasVideoDimensions = video.videoWidth > 0 && video.videoHeight > 0;

      if (hasVideoDimensions || isTranscodeAttempt) {
        hasPlaybackStarted = true;
        reconnectRetries = 0;
        if (stallTimer !== null) {
          window.clearTimeout(stallTimer);
          stallTimer = null;
        }
        if (noVideoTimer !== null) {
          window.clearTimeout(noVideoTimer);
          noVideoTimer = null;
        }
        setHasError(false);
        setIsLoading(false);
        setIsPlaying(true);
        return;
      }

      // Audio/metadata started on a non-transcode attempt, but videoWidth is still 0.
      // Wait up to 1400ms for video dimensions; if still 0, switch to FFmpeg H.264 transcoding.
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
        }, 1400);
      }
    };

    const handlePlaying = () => {
      if (!isMounted || isTransitioning) return;
      confirmOrWatchVideoTrack();
    };

    const handleResize = () => {
      if (!isMounted || isTransitioning) return;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        confirmOrWatchVideoTrack();
      }
    };

    const handleWaiting = () => {
      if (!isMounted || isTransitioning) return;
      setIsLoading(true);
    };

    const handleVideoError = () => {
      if (!isMounted || isTransitioning) return;
      const activeAttempt = attempts[currentAttemptIdx];
      // When Hls.js or mpegts.js is active, their own error listeners handle fallback
      if (activeAttempt?.mode === 'hls' && hls) return;
      if (activeAttempt?.mode === 'mpegts' && mpegtsPlayer) return;

      if (hasPlaybackStarted && reconnectRetries < 5) {
        reconnectRetries += 1;
        const savedTime = lastKnownTimestamp;
        setHasError(false);
        setIsLoading(true);
        if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(() => {
          if (!isMounted) return;
          const currentSrc = video.src || activeAttempt?.url || '';
          if (currentSrc.includes('/api/transcode')) {
            seekBaseOffsetRef.current = savedTime > 1 ? savedTime : 0;
            const base = currentSrc
              .replace(/([?&])ss=\d+/g, '')
              .replace(/([?&])_rc=\d+/g, '')
              .replace(/[?&]+$/, '');
            const sep = base.includes('?') ? '&' : '?';
            video.src = `${base}${sep}ss=${Math.floor(seekBaseOffsetRef.current)}&_rc=${Date.now()}`;
            video.load();
            safePlayVideo();
          } else if (currentSrc) {
            seekBaseOffsetRef.current = 0;
            const base = currentSrc.replace(/([?&])_rc=\d+/g, '').replace(/[?&]+$/, '');
            const sep = base.includes('?') ? '&' : '?';
            video.src = `${base}${sep}_rc=${Date.now()}`;
            video.load();
            if (savedTime > 1) {
              video.addEventListener(
                'loadedmetadata',
                () => {
                  try {
                    video.currentTime = savedTime;
                  } catch {
                    // ignore
                  }
                  safePlayVideo();
                },
                { once: true }
              );
            } else {
              safePlayVideo();
            }
          }
        }, 1200);
        return;
      }

      advanceToNextAttempt(attemptToken);
    };

    const handleTimeUpdate = () => {
      if (isTransitioning) return;
      const effectiveTime = seekBaseOffsetRef.current + video.currentTime;
      lastKnownTimestamp = effectiveTime;
      if (!isScrubbingRef.current) {
        setCurrentTime(effectiveTime);
      }
      if (
        video.duration &&
        Number.isFinite(video.duration) &&
        video.duration > 0
      ) {
        const bestDur = Math.max(knownVodDurationRef.current || 0, video.duration);
        knownVodDurationRef.current = bestDur;
        setIsLiveStream(false);
        setDuration(bestDur);
      } else if (knownVodDurationRef.current && knownVodDurationRef.current > 0) {
        setIsLiveStream(false);
        setDuration(knownVodDurationRef.current);
      }

      // Watchdog: if audio has been playing for >= 0.8s on a non-transcode attempt
      // but videoWidth is 0 (or 0 video frames decoded after 1.5s), switch to FFmpeg transcode
      const activeAttempt = attempts[currentAttemptIdx];
      if (
        activeAttempt &&
        !activeAttempt.url.includes('/api/transcode') &&
        video.currentTime >= 0.8
      ) {
        if (video.videoWidth === 0 || video.videoHeight === 0) {
          jumpToTranscodeOrNext(attemptToken);
          return;
        }
        if (video.currentTime >= 1.5 && typeof video.getVideoPlaybackQuality === 'function') {
          const quality = video.getVideoPlaybackQuality();
          if (quality && quality.totalVideoFrames === 0) {
            jumpToTranscodeOrNext(attemptToken);
            return;
          }
        }
      }
    };

    const handleLoadedMetadata = () => {
      if (!isMounted || isTransitioning) return;
      if (
        video.duration &&
        Number.isFinite(video.duration) &&
        video.duration > 0
      ) {
        const bestDur = Math.max(knownVodDurationRef.current || 0, video.duration);
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
        const bestDur = Math.max(knownVodDurationRef.current || 0, video.duration);
        knownVodDurationRef.current = bestDur;
        setIsLiveStream(false);
        setDuration(bestDur);
      }
    };

    video.addEventListener('playing', handlePlaying);
    video.addEventListener('canplay', handlePlaying);
    video.addEventListener('resize', handleResize);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('error', handleVideoError);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('durationchange', handleDurationChange);

    const probeController = new AbortController();
    fetch(
      `/api/probe?url=${encodeURIComponent(normalizedChannel.url)}${
        normalizedChannel.userAgent ? `&ua=${encodeURIComponent(normalizedChannel.userAgent)}` : ''
      }${normalizedChannel.referer ? `&ref=${encodeURIComponent(normalizedChannel.referer)}` : ''}${
        normalizedChannel.name ? `&title=${encodeURIComponent(normalizedChannel.name)}` : ''
      }`,
      { signal: probeController.signal }
    )
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

    runAttempt(0);

    return () => {
      isMounted = false;
      probeController.abort();
      clearTimers();
      destroyPlayers();
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('canplay', handlePlaying);
      video.removeEventListener('resize', handleResize);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('error', handleVideoError);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('durationchange', handleDurationChange);
    };
  }, [channel]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
    } else {
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
    const video = videoRef.current;
    if (!video) return;

    const startTranscodeSeek = (sec: number) => {
      setIsLoading(true);
      seekBaseOffsetRef.current = sec;
      const normalized = repairAndNormalizeChannel(channel);
      const transcodeBase = buildTranscodeUrl(normalized, 'full');
      video.src = `${transcodeBase}&ss=${Math.floor(sec)}&_rc=${Date.now()}`;
      video.load();
      video.play().catch(() => {});
    };

    if (video.src && video.src.includes('/api/transcode')) {
      startTranscodeSeek(clampedTime);
    } else {
      seekBaseOffsetRef.current = 0;
      try {
        video.currentTime = clampedTime;
      } catch {
        startTranscodeSeek(clampedTime);
        return;
      }
      window.setTimeout(() => {
        if (!videoRef.current) return;
        if (
          !videoRef.current.src.includes('/api/transcode') &&
          Math.abs(videoRef.current.currentTime - clampedTime) > 12
        ) {
          startTranscodeSeek(clampedTime);
        }
      }, 650);
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
