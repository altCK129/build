import { logger } from '../utils/logger';
import { Platform } from 'react-native';
import { YouTubeExtractor } from './youtubeExtractor';

export interface TrailerData {
  url: string;
  title: string;
  year: number;
}

interface CacheEntry {
  url: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Innertube search constants
// ---------------------------------------------------------------------------

const INNERTUBE_SEARCH_URL = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false';
const SEARCH_TIMEOUT_MS = 10000;

const WEB_SEARCH_CONTEXT = {
  client: {
    clientName: 'WEB',
    clientVersion: '2.20240726.00.00',
    hl: 'en',
    gl: 'US',
  },
};

export class TrailerService {
  // YouTube CDN URLs expire ~6h; cache for 5h
  private static readonly CACHE_TTL_MS = 5 * 60 * 60 * 1000;
  private static urlCache = new Map<string, CacheEntry>();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get a playable stream URL from a raw YouTube video ID (e.g. from TMDB).
   * Extracts on-device via Innertube — no server involved.
   */
  static async getTrailerFromVideoId(
    youtubeVideoId: string,
    title?: string,
    year?: number
  ): Promise<string | null> {
    if (!youtubeVideoId) return null;

    logger.info('TrailerService', `getTrailerFromVideoId: ${youtubeVideoId} (${title ?? '?'} ${year ?? ''})`);

    const cached = this.getCached(youtubeVideoId);
    if (cached) {
      logger.info('TrailerService', `Cache hit for videoId=${youtubeVideoId}`);
      return cached;
    }

    try {
      const platform = Platform.OS === 'android' ? 'android' : 'ios';
      const url = await YouTubeExtractor.getBestStreamUrl(youtubeVideoId, platform);
      if (url) {
        logger.info('TrailerService', `On-device extraction succeeded for ${youtubeVideoId}`);
        this.setCache(youtubeVideoId, url);
        return url;
      }
      logger.warn('TrailerService', `On-device extraction returned null for ${youtubeVideoId}`);
    } catch (err) {
      logger.warn('TrailerService', `On-device extraction threw for ${youtubeVideoId}:`, err);
    }

    return null;
  }

  /**
   * Called by TrailerModal which has the full YouTube URL from TMDB.
   * Parses the video ID then delegates to getTrailerFromVideoId.
   */
  static async getTrailerFromYouTubeUrl(
    youtubeUrl: string,
    title?: string,
    year?: string
  ): Promise<string | null> {
    logger.info('TrailerService', `getTrailerFromYouTubeUrl: ${youtubeUrl}`);

    const videoId = YouTubeExtractor.parseVideoId(youtubeUrl);
    if (!videoId) {
      logger.warn('TrailerService', `Could not parse video ID from: ${youtubeUrl}`);
      return null;
    }

    return this.getTrailerFromVideoId(
      videoId,
      title,
      year ? parseInt(year, 10) : undefined
    );
  }

  /**
   * Called by AppleTVHero and HeroSection which only have title/year/tmdbId.
   * Searches YouTube on-device via Innertube, then extracts the best stream.
   */
  static async getTrailerUrl(
    title: string,
    year: number,
    tmdbId?: string,
    type?: 'movie' | 'tv'
  ): Promise<string | null> {
    logger.info('TrailerService', `getTrailerUrl: searching on-device for "${title}" (${year})`);

    const cacheKey = `search:${title}:${year}:${tmdbId ?? ''}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const videoId = await this.searchYouTubeForTrailer(title, year, type);
    if (!videoId) {
      logger.warn('TrailerService', `YouTube search returned no results for "${title}"`);
      return null;
    }

    logger.info('TrailerService', `YouTube search found videoId=${videoId} for "${title}"`);
    const url = await this.getTrailerFromVideoId(videoId, title, year);
    if (url) {
      this.setCache(cacheKey, url);
    }
    return url;
  }

  // ---------------------------------------------------------------------------
  // Public helpers (API compatibility)
  // ---------------------------------------------------------------------------

  static getBestFormatUrl(url: string): string {
    if (url.includes('formats=')) {
      if (url.includes('M3U')) {
        return `${url.split('?')[0]}?formats=M3U+none,M3U+appleHlsEncryption`;
      }
      if (url.includes('MPEG4')) {
        return `${url.split('?')[0]}?formats=MPEG4`;
      }
    }
    return url;
  }

  static async isTrailerAvailable(videoId: string): Promise<boolean> {
    return (await this.getTrailerFromVideoId(videoId)) !== null;
  }

  static async getTrailerData(title: string, year: number): Promise<TrailerData | null> {
    const url = await this.getTrailerUrl(title, year);
    if (!url) return null;
    return { url: this.getBestFormatUrl(url), title, year };
  }

  /** No-op — kept for API compatibility with any callers that still reference it */
  static setUseLocalServer(_useLocal: boolean): void {
    logger.info('TrailerService', 'setUseLocalServer: no-op, server removed');
  }

  static getServerStatus(): { usingLocal: boolean; localUrl: string } {
    return { usingLocal: false, localUrl: '' };
  }

  static async testServers(): Promise<{
    localServer: { status: 'online' | 'offline'; responseTime?: number };
  }> {
    return { localServer: { status: 'offline' } };
  }

  // ---------------------------------------------------------------------------
  // Private — on-device YouTube search via Innertube
  // ---------------------------------------------------------------------------

  /**
   * Uses the Innertube search endpoint to find the best trailer video ID
   * for a given title/year. Returns the first result whose title contains
   * "trailer" (case-insensitive), or the first result overall as a fallback.
   */
  private static async searchYouTubeForTrailer(
    title: string,
    year: number,
    type?: 'movie' | 'tv'
  ): Promise<string | null> {
    const mediaType = type === 'tv' ? 'series' : 'movie';
    const query = `${title} ${year} ${mediaType} official trailer`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    try {
      const response = await fetch(
        INNERTUBE_SEARCH_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': '1',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
            'Origin': 'https://www.youtube.com',
            'Referer': 'https://www.youtube.com/',
          },
          body: JSON.stringify({
            query,
            context: WEB_SEARCH_CONTEXT,
            params: 'EgIQAQ%3D%3D', // filter: videos only
          }),
          signal: controller.signal,
        }
      );

      clearTimeout(timer);

      if (!response.ok) {
        logger.warn('TrailerService', `Innertube search HTTP ${response.status} for "${query}"`);
        return null;
      }

      const data = await response.json();
      return this.parseSearchResultVideoId(data, title);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        logger.warn('TrailerService', `Innertube search timed out for "${query}"`);
      } else {
        logger.warn('TrailerService', `Innertube search error:`, err);
      }
      return null;
    }
  }

  /**
   * Walks the Innertube search response JSON and picks the best video ID.
   * Prefers results with "trailer" in the title, falls back to first video found.
   */
  private static parseSearchResultVideoId(data: any, title: string): string | null {
    try {
      const contents =
        data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
          ?.sectionListRenderer?.contents ?? [];

      const videoRenderers: Array<{ videoId: string; titleText: string }> = [];

      for (const section of contents) {
        const items = section?.itemSectionRenderer?.contents ?? [];
        for (const item of items) {
          const vr = item?.videoRenderer;
          if (!vr?.videoId) continue;
          const titleText: string =
            vr.title?.runs?.map((r: any) => r.text).join('') ?? '';
          videoRenderers.push({ videoId: vr.videoId, titleText });
        }
      }

      if (videoRenderers.length === 0) {
        logger.warn('TrailerService', 'Innertube search: no video renderers found in response');
        return null;
      }

      // Prefer a result that mentions "trailer" in its title
      const trailerMatch = videoRenderers.find(v =>
        v.titleText.toLowerCase().includes('trailer')
      );
      if (trailerMatch) {
        logger.info('TrailerService', `Search matched trailer: "${trailerMatch.titleText}" → ${trailerMatch.videoId}`);
        return trailerMatch.videoId;
      }

      // Fallback: first result
      const first = videoRenderers[0];
      logger.info('TrailerService', `Search fallback to first result: "${first.titleText}" → ${first.videoId}`);
      return first.videoId;
    } catch (err) {
      logger.warn('TrailerService', 'parseSearchResultVideoId failed:', err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — cache
  // ---------------------------------------------------------------------------

  private static getCached(key: string): string | null {
    const entry = this.urlCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.urlCache.delete(key);
      return null;
    }
    // Don't return cached .mpd file paths — the temp file may no longer exist
    // after an app restart, and we'd rather re-extract than serve a dead file URI
    if (entry.url.endsWith('.mpd')) {
      this.urlCache.delete(key);
      return null;
    }
    return entry.url;
  }

  private static setCache(key: string, url: string): void {
    this.urlCache.set(key, { url, expiresAt: Date.now() + this.CACHE_TTL_MS });
    if (this.urlCache.size > 100) {
      const oldest = this.urlCache.keys().next().value;
      if (oldest) this.urlCache.delete(oldest);
    }
  }
}

export default TrailerService;
