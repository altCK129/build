import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InnertubeFormat {
  itag: number;
  url?: string;
  signatureCipher?: string;
  mimeType: string;
  bitrate: number;
  width?: number;
  height?: number;
  contentLength?: string;
  quality: string;
  qualityLabel?: string;
  audioQuality?: string;
  audioSampleRate?: string;
  audioChannels?: number;
  approxDurationMs?: string;
  lastModified?: string;
  projectionType?: string;
}

interface InnertubeStreamingData {
  formats: InnertubeFormat[];
  adaptiveFormats: InnertubeFormat[];
  expiresInSeconds?: string;
}

interface InnertubePlayerResponse {
  streamingData?: InnertubeStreamingData;
  videoDetails?: {
    videoId: string;
    title: string;
    lengthSeconds: string;
    isLive?: boolean;
    isLiveDvr?: boolean;
  };
  playabilityStatus?: {
    status: string;
    reason?: string;
  };
}

export interface ExtractedStream {
  url: string;
  quality: string;        // e.g. "720p", "480p"
  mimeType: string;       // e.g. "video/mp4"
  itag: number;
  hasAudio: boolean;
  hasVideo: boolean;
  bitrate: number;
}

export interface YouTubeExtractionResult {
  streams: ExtractedStream[];
  bestStream: ExtractedStream | null;
  videoId: string;
  title?: string;
  durationSeconds?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Innertube client configs — we use Android (no cipher, direct URLs)
// and web as fallback (may need cipher decode)
const INNERTUBE_API_KEY = 'AIzaSyA8ggJvXiQHQFN-YMEoM30s0s3RlxEYJuA';
const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player';

// Android client gives direct URLs without cipher obfuscation
const ANDROID_CLIENT_CONTEXT = {
  client: {
    clientName: 'ANDROID',
    clientVersion: '19.09.37',
    androidSdkVersion: 30,
    userAgent:
      'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
    hl: 'en',
    gl: 'US',
  },
};

// iOS client as secondary fallback
const IOS_CLIENT_CONTEXT = {
  client: {
    clientName: 'IOS',
    clientVersion: '19.09.3',
    deviceModel: 'iPhone14,3',
    userAgent:
      'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iPhone OS 15_6 like Mac OS X)',
    hl: 'en',
    gl: 'US',
  },
};

// TV Embedded client — works for age-restricted / embed-allowed content
const TVHTML5_EMBEDDED_CONTEXT = {
  client: {
    clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
    clientVersion: '2.0',
    hl: 'en',
    gl: 'US',
  },
};

// ---------------------------------------------------------------------------
// Itag reference tables
// ---------------------------------------------------------------------------

// Muxed (video+audio in one file) — these are the ONLY formats iOS AVPlayer
// can play without a DASH bridge. Max quality is 720p (itag 22), often absent.
const PREFERRED_MUXED_ITAGS = [
  22,   // 720p MP4 (video+audio)
  59,   // 480p MP4 (video+audio) — rare
  78,   // 480p MP4 (video+audio) — rare
];

// Adaptive video-only itags in descending quality order.
// ExoPlayer on Android can combine these with an audio stream via DASH.
const ADAPTIVE_VIDEO_ITAGS_RANKED = [
  137,  // 1080p MP4 video-only
  248,  // 1080p WebM video-only
  136,  // 720p MP4 video-only
  247,  // 720p WebM video-only
  135,  // 480p MP4 video-only
  244,  // 480p WebM video-only
  134,  // 360p MP4 video-only
  243,  // 360p WebM video-only
];

// Adaptive audio-only itags in descending quality order.
const ADAPTIVE_AUDIO_ITAGS_RANKED = [
  141,  // 256kbps AAC
  140,  // 128kbps AAC  ← most common
  251,  // 160kbps Opus
  250,  // 70kbps Opus
  249,  // 50kbps Opus
];

const REQUEST_TIMEOUT_MS = 12000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractVideoId(input: string): string | null {
  if (!input) return null;

  // Already a bare video ID (11 chars, alphanumeric + _ -)
  if (/^[A-Za-z0-9_-]{11}$/.test(input.trim())) {
    return input.trim();
  }

  try {
    const url = new URL(input);

    // youtu.be/VIDEO_ID
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    }

    // youtube.com/watch?v=VIDEO_ID
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;

    // youtube.com/embed/VIDEO_ID or /shorts/VIDEO_ID
    const pathMatch = url.pathname.match(/\/(embed|shorts|v)\/([A-Za-z0-9_-]{11})/);
    if (pathMatch) return pathMatch[2];
  } catch {
    // Not a valid URL — try regex fallback
    const match = input.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (match) return match[1];
  }

  return null;
}

function parseMimeType(mimeType: string): { container: string; codecs: string } {
  // e.g. 'video/mp4; codecs="avc1.64001F, mp4a.40.2"'
  const [base, codecsPart] = mimeType.split(';');
  const container = base.trim();
  const codecs = codecsPart ? codecsPart.replace(/codecs=["']?/i, '').replace(/["']$/, '').trim() : '';
  return { container, codecs };
}

function isMuxedFormat(format: InnertubeFormat): boolean {
  // A muxed format has both video and audio codecs in its mimeType
  const { codecs } = parseMimeType(format.mimeType);
  // MP4 muxed: "avc1.xxx, mp4a.xxx"
  // WebM muxed: "vp8, vorbis" etc.
  return codecs.includes(',') || (!!format.audioQuality && !!format.qualityLabel);
}

function isVideoMp4(format: InnertubeFormat): boolean {
  return format.mimeType.startsWith('video/mp4');
}

function formatQualityLabel(format: InnertubeFormat): string {
  return format.qualityLabel || format.quality || 'unknown';
}

function scoreFormat(format: InnertubeFormat): number {
  const preferredIndex = PREFERRED_MUXED_ITAGS.indexOf(format.itag);
  const itagBonus = preferredIndex !== -1 ? (PREFERRED_MUXED_ITAGS.length - preferredIndex) * 10000 : 0;
  const height = format.height ?? 0;
  const heightScore = Math.min(height, 720) * 10;
  const bitrateScore = Math.min(format.bitrate ?? 0, 3_000_000) / 1000;
  return itagBonus + heightScore + bitrateScore;
}

// ---------------------------------------------------------------------------
// Adaptive stream selection helpers
// ---------------------------------------------------------------------------

/** Pick the best video-only adaptive format available (MP4 preferred). */
function pickBestAdaptiveVideo(adaptiveFormats: InnertubeFormat[]): InnertubeFormat | null {
  const videoOnly = adaptiveFormats.filter(
    (f) => f.url && f.qualityLabel && !f.audioQuality && f.mimeType.startsWith('video/')
  );
  if (videoOnly.length === 0) return null;

  for (const itag of ADAPTIVE_VIDEO_ITAGS_RANKED) {
    const match = videoOnly.find((f) => f.itag === itag);
    if (match) return match;
  }
  return videoOnly.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ?? null;
}

/** Pick the best audio-only adaptive format available (AAC preferred). */
function pickBestAdaptiveAudio(adaptiveFormats: InnertubeFormat[]): InnertubeFormat | null {
  const audioOnly = adaptiveFormats.filter(
    (f) => f.url && f.audioQuality && !f.qualityLabel && f.mimeType.startsWith('audio/')
  );
  if (audioOnly.length === 0) return null;

  for (const itag of ADAPTIVE_AUDIO_ITAGS_RANKED) {
    const match = audioOnly.find((f) => f.itag === itag);
    if (match) return match;
  }
  return audioOnly.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ?? null;
}

/**
 * Build an in-memory DASH MPD XML that references separate video + audio streams.
 * ExoPlayer (Android) can parse a data:application/dash+xml;base64,... URI directly.
 * iOS AVPlayer does NOT support DASH — this path is Android-only.
 */
function buildDashManifest(
  videoFormat: InnertubeFormat,
  audioFormat: InnertubeFormat,
  durationSeconds?: number
): string | null {
  try {
    const duration = durationSeconds ?? 300;
    const mediaDurationISO = `PT${duration}S`;

    const videoCodec = parseMimeType(videoFormat.mimeType).codecs.replace(/"/g, '').trim();
    const audioCodec = parseMimeType(audioFormat.mimeType).codecs.replace(/"/g, '').trim();
    const videoMime = videoFormat.mimeType.split(';')[0].trim();
    const audioMime = audioFormat.mimeType.split(';')[0].trim();

    const width = videoFormat.width ?? 1920;
    const height = videoFormat.height ?? 1080;
    const videoBandwidth = videoFormat.bitrate ?? 2_000_000;
    const audioBandwidth = audioFormat.bitrate ?? 128_000;
    const audioSampleRate = audioFormat.audioSampleRate ?? '44100';

    const escapeXml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const videoUrl = escapeXml(videoFormat.url!);
    const audioUrl = escapeXml(audioFormat.url!);

    const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="${mediaDurationISO}" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period duration="${mediaDurationISO}">
    <AdaptationSet id="1" mimeType="${videoMime}" codecs="${videoCodec}" width="${width}" height="${height}" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
      <Representation id="v1" bandwidth="${videoBandwidth}" width="${width}" height="${height}">
        <BaseURL>${videoUrl}</BaseURL>
        <SegmentBase><Initialization range="0-0"/></SegmentBase>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="2" mimeType="${audioMime}" codecs="${audioCodec}" lang="en" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
      <Representation id="a1" bandwidth="${audioBandwidth}" audioSamplingRate="${audioSampleRate}">
        <BaseURL>${audioUrl}</BaseURL>
        <SegmentBase><Initialization range="0-0"/></SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

    const b64 = Buffer.from(mpd, 'utf8').toString('base64');
    return `data:application/dash+xml;base64,${b64}`;
  } catch (err) {
    logger.warn('YouTubeExtractor', 'Failed to build DASH manifest:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core extractor
// ---------------------------------------------------------------------------

async function fetchPlayerResponse(
  videoId: string,
  context: object,
  userAgent: string
): Promise<InnertubePlayerResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const body = {
      videoId,
      context,
      contentCheckOk: true,
      racyCheckOk: true,
    };

    const response = await fetch(
      `${INNERTUBE_URL}?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': userAgent,
          'X-YouTube-Client-Name': '3',
          'Origin': 'https://www.youtube.com',
          'Referer': `https://www.youtube.com/watch?v=${videoId}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );

    clearTimeout(timer);

    if (!response.ok) {
      logger.warn('YouTubeExtractor', `Innertube HTTP ${response.status} for videoId=${videoId}`);
      return null;
    }

    const data: InnertubePlayerResponse = await response.json();
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn('YouTubeExtractor', `Request timed out for videoId=${videoId}`);
    } else {
      logger.warn('YouTubeExtractor', `Fetch error for videoId=${videoId}:`, err);
    }
    return null;
  }
}

/**
 * Returns muxed formats (video+audio) from sd.formats, plus any muxed adaptive formats.
 * Used as the iOS fallback and the basis for the muxed bestStream.
 */
function parseMuxedFormats(playerResponse: InnertubePlayerResponse): InnertubeFormat[] {
  const sd = playerResponse.streamingData;
  if (!sd) return [];

  const formats: InnertubeFormat[] = [];
  for (const f of sd.formats ?? []) {
    if (f.url) formats.push(f);
  }
  // Edge case: some adaptive formats are actually muxed
  for (const f of sd.adaptiveFormats ?? []) {
    if (f.url && isMuxedFormat(f)) formats.push(f);
  }
  return formats;
}

/**
 * Returns all adaptive formats (video-only + audio-only) that have direct URLs.
 * Used for DASH manifest building on Android.
 */
function parseAdaptiveFormats(playerResponse: InnertubePlayerResponse): InnertubeFormat[] {
  const sd = playerResponse.streamingData;
  if (!sd) return [];
  return (sd.adaptiveFormats ?? []).filter((f) => !!f.url);
}

function pickBestMuxedStream(formats: InnertubeFormat[]): ExtractedStream | null {
  if (formats.length === 0) return null;

  const mp4Formats = formats.filter(isVideoMp4);
  const pool = mp4Formats.length > 0 ? mp4Formats : formats;
  const sorted = [...pool].sort((a, b) => scoreFormat(b) - scoreFormat(a));
  const best = sorted[0];

  return {
    url: best.url!,
    quality: formatQualityLabel(best),
    mimeType: best.mimeType,
    itag: best.itag,
    hasAudio: !!best.audioQuality || isMuxedFormat(best),
    hasVideo: !!best.qualityLabel || best.mimeType.startsWith('video/'),
    bitrate: best.bitrate ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class YouTubeExtractor {
  /**
   * Extract a playable stream URL from a YouTube video ID or URL.
   *
   * Strategy:
   *  - Android: Try to build a DASH manifest from the best adaptive video +
   *    audio streams (up to 1080p). Falls back to best muxed stream (≤720p).
   *  - iOS: Use best muxed stream only (AVPlayer has no DASH support).
   *
   * Tries Android Innertube client first, then iOS, then TV Embedded.
   */
  static async extract(videoIdOrUrl: string, platform?: 'android' | 'ios'): Promise<YouTubeExtractionResult | null> {
    const videoId = extractVideoId(videoIdOrUrl);
    if (!videoId) {
      logger.warn('YouTubeExtractor', `Could not parse video ID from: ${videoIdOrUrl}`);
      return null;
    }

    logger.info('YouTubeExtractor', `Extracting streams for videoId=${videoId} platform=${platform ?? 'unknown'}`);

    const clients: Array<{ context: object; userAgent: string; name: string }> = [
      {
        name: 'ANDROID',
        context: ANDROID_CLIENT_CONTEXT,
        userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
      },
      {
        name: 'IOS',
        context: IOS_CLIENT_CONTEXT,
        userAgent: 'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iPhone OS 15_6 like Mac OS X)',
      },
      {
        name: 'TVHTML5_EMBEDDED',
        context: TVHTML5_EMBEDDED_CONTEXT,
        userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)',
      },
    ];

    let muxedFormats: InnertubeFormat[] = [];
    let adaptiveFormats: InnertubeFormat[] = [];
    let playerResponse: InnertubePlayerResponse | null = null;

    for (const client of clients) {
      logger.info('YouTubeExtractor', `Trying ${client.name} client...`);
      const resp = await fetchPlayerResponse(videoId, client.context, client.userAgent);

      if (!resp) continue;

      const status = resp.playabilityStatus?.status;
      if (status === 'UNPLAYABLE' || status === 'LOGIN_REQUIRED') {
        logger.warn('YouTubeExtractor', `${client.name}: playabilityStatus=${status}`);
        continue;
      }

      const muxed = parseMuxedFormats(resp);
      const adaptive = parseAdaptiveFormats(resp);

      if (muxed.length > 0 || adaptive.length > 0) {
        logger.info('YouTubeExtractor', `${client.name}: ${muxed.length} muxed, ${adaptive.length} adaptive formats`);
        muxedFormats = muxed;
        adaptiveFormats = adaptive;
        playerResponse = resp;
        break;
      }

      logger.warn('YouTubeExtractor', `${client.name} returned no usable formats`);
    }

    if (muxedFormats.length === 0 && adaptiveFormats.length === 0) {
      logger.warn('YouTubeExtractor', `All clients failed for videoId=${videoId}`);
      return null;
    }

    const details = playerResponse?.videoDetails;
    const durationSeconds = details?.lengthSeconds ? parseInt(details.lengthSeconds, 10) : undefined;

    // --- Android: attempt high-quality DASH manifest ---
    let bestStream: ExtractedStream | null = null;

    if (platform === 'android' && adaptiveFormats.length > 0) {
      const bestVideo = pickBestAdaptiveVideo(adaptiveFormats);
      const bestAudio = pickBestAdaptiveAudio(adaptiveFormats);

      if (bestVideo && bestAudio) {
        const dashUri = buildDashManifest(bestVideo, bestAudio, durationSeconds);
        if (dashUri) {
          logger.info(
            'YouTubeExtractor',
            `DASH manifest built: video itag=${bestVideo.itag} (${formatQualityLabel(bestVideo)}), audio itag=${bestAudio.itag}`
          );
          bestStream = {
            url: dashUri,
            quality: formatQualityLabel(bestVideo),
            mimeType: 'application/dash+xml',
            itag: bestVideo.itag,
            hasAudio: true,
            hasVideo: true,
            bitrate: (bestVideo.bitrate ?? 0) + (bestAudio.bitrate ?? 0),
          };
        } else {
          logger.warn('YouTubeExtractor', 'DASH manifest build failed, falling back to muxed');
        }
      } else {
        logger.info('YouTubeExtractor', `Adaptive: bestVideo=${bestVideo?.itag ?? 'none'}, bestAudio=${bestAudio?.itag ?? 'none'} — falling back to muxed`);
      }
    }

    // --- iOS or DASH fallback: use best muxed stream ---
    if (!bestStream) {
      bestStream = pickBestMuxedStream(muxedFormats);
      if (bestStream) {
        logger.info('YouTubeExtractor', `Muxed fallback: itag=${bestStream.itag} quality=${bestStream.quality}`);
      }
    }

    // Build the full streams list from muxed formats for the result object
    const streams: ExtractedStream[] = muxedFormats.map((f) => ({
      url: f.url!,
      quality: formatQualityLabel(f),
      mimeType: f.mimeType,
      itag: f.itag,
      hasAudio: !!f.audioQuality || isMuxedFormat(f),
      hasVideo: !!f.qualityLabel || f.mimeType.startsWith('video/'),
      bitrate: f.bitrate ?? 0,
    }));

    return {
      streams,
      bestStream,
      videoId,
      title: details?.title,
      durationSeconds,
    };
  }

  /**
   * Convenience method — returns just the best playable URL or null.
   * Pass platform so the extractor can choose DASH vs muxed appropriately.
   */
  static async getBestStreamUrl(videoIdOrUrl: string, platform?: 'android' | 'ios'): Promise<string | null> {
    const result = await this.extract(videoIdOrUrl, platform);
    return result?.bestStream?.url ?? null;
  }

  /**
   * Parse a video ID from any YouTube URL format or bare ID.
   */
  static parseVideoId(input: string): string | null {
    return extractVideoId(input);
  }
}

export default YouTubeExtractor;
