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

export class TrailerService {
  // ---- Remote server (fallback only) ----
  private static readonly ENV_LOCAL_BASE =
    process.env.EXPO_PUBLIC_TRAILER_LOCAL_BASE || 'http://46.62.173.157:3001';
  private static readonly ENV_LOCAL_TRAILER_PATH =
    process.env.EXPO_PUBLIC_TRAILER_LOCAL_TRAILER_PATH || '/trailer';
  private static readonly ENV_LOCAL_SEARCH_PATH =
    process.env.EXPO_PUBLIC_TRAILER_LOCAL_SEARCH_PATH || '/search-trailer';

  private static readonly LOCAL_SERVER_URL = `${TrailerService.ENV_LOCAL_BASE}${TrailerService.ENV_LOCAL_TRAILER_PATH}`;
  private static readonly AUTO_SEARCH_URL = `${TrailerService.ENV_LOCAL_BASE}${TrailerService.ENV_LOCAL_SEARCH_PATH}`;
  private static readonly SERVER_TIMEOUT = 20000;

  // YouTube CDN URLs expire ~6h; cache for 5h
  private static readonly CACHE_TTL_MS = 5 * 60 * 60 * 1000;
  private static urlCache = new Map<string, CacheEntry>();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get a playable stream URL from a raw YouTube video ID (e.g. from TMDB).
   * Tries on-device extraction first, falls back to remote server.
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

    // 1. On-device extraction via Innertube
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

    // 2. Server fallback
    logger.info('TrailerService', `Falling back to server for ${youtubeVideoId}`);
    const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;
    const serverUrl = await this.fetchFromServer(youtubeUrl, title, year?.toString());
    if (serverUrl) {
      this.setCache(youtubeVideoId, serverUrl);
      return serverUrl;
    }

    logger.warn('TrailerService', `Both on-device and server failed for ${youtubeVideoId}`);
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
      // No video ID — try server directly with the raw URL
      return this.fetchFromServer(youtubeUrl, title, year);
    }

    return this.getTrailerFromVideoId(
      videoId,
      title,
      year ? parseInt(year, 10) : undefined
    );
  }

  /**
   * Called by AppleTVHero and HeroSection which only have title/year/tmdbId.
   * No YouTube video ID available — goes straight to server search.
   */
  static async getTrailerUrl(
    title: string,
    year: number,
    tmdbId?: string,
    type?: 'movie' | 'tv'
  ): Promise<string | null> {
    logger.warn(
      'TrailerService',
      `getTrailerUrl called for "${title}" — no YouTube video ID, using server search`
    );

    const cacheKey = `search:${title}:${year}:${tmdbId ?? ''}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const serverResult = await this.getTrailerFromServer(title, year, tmdbId, type);
    if (serverResult) {
      this.setCache(cacheKey, serverResult);
    }
    return serverResult;
  }

  // ---------------------------------------------------------------------------
  // Unchanged public helpers (API compatibility)
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

  static setUseLocalServer(_useLocal: boolean): void {
    logger.info('TrailerService', 'setUseLocalServer: server used as fallback only');
  }

  static getServerStatus(): { usingLocal: boolean; localUrl: string } {
    return { usingLocal: true, localUrl: this.LOCAL_SERVER_URL };
  }

  static async testServers(): Promise<{
    localServer: { status: 'online' | 'offline'; responseTime?: number };
  }> {
    try {
      const t = Date.now();
      const r = await fetch(`${this.AUTO_SEARCH_URL}?title=test&year=2023`, {
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok || r.status === 404) {
        return { localServer: { status: 'online', responseTime: Date.now() - t } };
      }
    } catch { /* offline */ }
    return { localServer: { status: 'offline' } };
  }

  // ---------------------------------------------------------------------------
  // Private — server requests
  // ---------------------------------------------------------------------------

  private static async getTrailerFromServer(
    title: string,
    year: number,
    tmdbId?: string,
    type?: 'movie' | 'tv'
  ): Promise<string | null> {
    const params = new URLSearchParams({ title, year: year.toString() });
    if (tmdbId) {
      params.append('tmdbId', tmdbId);
      params.append('type', type ?? 'movie');
    }
    return this.doServerFetch(`${this.AUTO_SEARCH_URL}?${params}`);
  }

  private static async fetchFromServer(
    youtubeUrl: string,
    title?: string,
    year?: string
  ): Promise<string | null> {
    const params = new URLSearchParams({ youtube_url: youtubeUrl });
    if (title) params.append('title', title);
    if (year) params.append('year', year);
    return this.doServerFetch(`${this.LOCAL_SERVER_URL}?${params}`);
  }

  private static async doServerFetch(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.SERVER_TIMEOUT);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Nuvio/1.0' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        logger.warn('TrailerService', `Server ${res.status} for ${url}`);
        return null;
      }
      const data = await res.json();
      if (!data.url || !this.isValidTrailerUrl(data.url)) {
        logger.warn('TrailerService', `Server returned invalid URL: ${data.url}`);
        return null;
      }
      logger.info('TrailerService', `Server fallback succeeded: ${String(data.url).substring(0, 80)}`);
      return data.url as string;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        logger.warn('TrailerService', `Server timed out: ${url}`);
      } else {
        logger.warn('TrailerService', `Server fetch error:`, err);
      }
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

  // ---------------------------------------------------------------------------
  // Private — URL validation
  // ---------------------------------------------------------------------------

  private static isValidTrailerUrl(url: string): boolean {
    try {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) return false;
      const host = u.hostname.toLowerCase();
      return (
        ['theplatform.com', 'youtube.com', 'youtu.be', 'vimeo.com',
          'dailymotion.com', 'twitch.tv', 'amazonaws.com',
          'cloudfront.net', 'googlevideo.com'].some(d => host.includes(d)) ||
        /\.(mp4|m3u8|mpd|webm|mov)(\?|$)/i.test(u.pathname)
      );
    } catch {
      return false;
    }
  }
}

export default TrailerService;
