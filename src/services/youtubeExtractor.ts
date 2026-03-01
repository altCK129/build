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

// Preferred itags: muxed (video+audio) formats, best quality first
// These are single-file MP4s ExoPlayer can play directly
const PREFERRED_MUXED_ITAGS = [
  22,   // 720p MP4 (video+audio)
  59,   // 480p MP4 (video+audio) — rare
  78,   // 480p MP4 (video+audio) — rare
  135,  // 480p video-only (fallback)
  134,  // 360p video-only (fallback)
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
  // Prioritise:
  // 1. Preferred itags (pre-muxed MP4 with audio)
  // 2. Height (higher = better, but cap at 720 for stability)
  // 3. Bitrate
  const preferredIndex = PREFERRED_MUXED_ITAGS.indexOf(format.itag);
  const itagBonus = preferredIndex !== -1 ? (PREFERRED_MUXED_ITAGS.length - preferredIndex) * 10000 : 0;
  const height = format.height ?? 0;
  // Don't prefer > 720p because those are usually adaptive-only
  const heightScore = Math.min(height, 720) * 10;
  const bitrateScore = Math.min(format.bitrate ?? 0, 3_000_000) / 1000;
  return itagBonus + heightScore + bitrateScore;
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

function parseFormats(playerResponse: InnertubePlayerResponse): InnertubeFormat[] {
  const sd = playerResponse.streamingData;
  if (!sd) return [];

  const formats: InnertubeFormat[] = [];

  // Include muxed formats (video+audio in one file)
  for (const f of sd.formats ?? []) {
    if (f.url) formats.push(f);
  }

  // Also scan adaptiveFormats for any that happen to have a direct URL
  // and look muxed (edge case but occasionally seen)
  for (const f of sd.adaptiveFormats ?? []) {
    if (f.url && isMuxedFormat(f)) formats.push(f);
  }

  return formats;
}

function pickBestStream(formats: InnertubeFormat[]): ExtractedStream | null {
  if (formats.length === 0) return null;

  // Filter to MP4 only for maximum ExoPlayer compatibility
  const mp4Formats = formats.filter(isVideoMp4);
  const pool = mp4Formats.length > 0 ? mp4Formats : formats;

  // Sort by score descending
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
   * Tries Android client first (no cipher), then iOS, then TV embedded.
   * Returns null if all attempts fail.
   */
  static async extract(videoIdOrUrl: string): Promise<YouTubeExtractionResult | null> {
    const videoId = extractVideoId(videoIdOrUrl);
    if (!videoId) {
      logger.warn('YouTubeExtractor', `Could not parse video ID from: ${videoIdOrUrl}`);
      return null;
    }

    logger.info('YouTubeExtractor', `Extracting streams for videoId=${videoId}`);

    // Try each client in order until we get usable formats
    const clients: Array<{ context: object; userAgent: string; name: string }> = [
      {
        name: 'ANDROID',
        context: ANDROID_CLIENT_CONTEXT,
        userAgent:
          'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
      },
      {
        name: 'IOS',
        context: IOS_CLIENT_CONTEXT,
        userAgent:
          'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iPhone OS 15_6 like Mac OS X)',
      },
      {
        name: 'TVHTML5_EMBEDDED',
        context: TVHTML5_EMBEDDED_CONTEXT,
        userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)',
      },
    ];

    let bestFormats: InnertubeFormat[] = [];
    let playerResponse: InnertubePlayerResponse | null = null;

    for (const client of clients) {
      logger.info('YouTubeExtractor', `Trying ${client.name} client...`);
      const resp = await fetchPlayerResponse(videoId, client.context, client.userAgent);

      if (!resp) continue;

      const status = resp.playabilityStatus?.status;
      if (status === 'UNPLAYABLE' || status === 'LOGIN_REQUIRED') {
        logger.warn(
          'YouTubeExtractor',
          `${client.name} got playabilityStatus=${status} (${resp.playabilityStatus?.reason ?? ''})`
        );
        continue;
      }

      const formats = parseFormats(resp);
      if (formats.length > 0) {
        logger.info(
          'YouTubeExtractor',
          `${client.name} returned ${formats.length} usable formats`
        );
        bestFormats = formats;
        playerResponse = resp;
        break;
      }

      logger.warn('YouTubeExtractor', `${client.name} returned no direct-URL formats`);
    }

    if (bestFormats.length === 0) {
      logger.warn('YouTubeExtractor', `All clients failed for videoId=${videoId}`);
      return null;
    }

    const streams: ExtractedStream[] = bestFormats.map((f) => ({
      url: f.url!,
      quality: formatQualityLabel(f),
      mimeType: f.mimeType,
      itag: f.itag,
      hasAudio: !!f.audioQuality || isMuxedFormat(f),
      hasVideo: !!f.qualityLabel || f.mimeType.startsWith('video/'),
      bitrate: f.bitrate ?? 0,
    }));

    const bestStream = pickBestStream(bestFormats);

    const details = playerResponse?.videoDetails;
    const result: YouTubeExtractionResult = {
      streams,
      bestStream,
      videoId,
      title: details?.title,
      durationSeconds: details?.lengthSeconds
        ? parseInt(details.lengthSeconds, 10)
        : undefined,
    };

    if (bestStream) {
      logger.info(
        'YouTubeExtractor',
        `Best stream: itag=${bestStream.itag} quality=${bestStream.quality} mimeType=${bestStream.mimeType}`
      );
    }

    return result;
  }

  /**
   * Convenience method — returns just the best playable URL or null.
   */
  static async getBestStreamUrl(videoIdOrUrl: string): Promise<string | null> {
    const result = await this.extract(videoIdOrUrl);
    return result?.bestStream?.url ?? null;
  }

  /**
   * Parse a video ID from any YouTube URL format or bare ID.
   * Exposed so callers can validate IDs before calling extract().
   */
  static parseVideoId(input: string): string | null {
    return extractVideoId(input);
  }
}

export default YouTubeExtractor;
