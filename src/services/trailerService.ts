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
  // YouTube CDN URLs expire ~6h; cache for 5h
  private static readonly CACHE_TTL_MS = 5 * 60 * 60 * 1000;
  private static urlCache = new Map<string, CacheEntry>();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get a playable stream URL from a raw YouTube video ID (e.g. from TMDB).
   * Pure on-device extraction via Innertube. No server involved.
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
    } catch (err) {
      logger.warn('TrailerService', `On-device extraction threw for ${youtubeVideoId}:`, err);
    }

    logger.warn('TrailerService', `Extraction failed for ${youtubeVideoId}`);
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
   * These callers need to be updated to pass the YouTube video ID from TMDB
   * instead and call getTrailerFromVideoId directly. Until then this returns null.
   */
  static async getTrailerUrl(
    title: string,
    year: number,
    _tmdbId?: string,
    _type?: 'movie' | 'tv'
  ): Promise<string | null> {
    logger.warn(
      'TrailerService',
      `getTrailerUrl called for "${title}" but no YouTube video ID was provided. ` +
      `Update caller to fetch the YouTube video ID from TMDB and call getTrailerFromVideoId instead.`
    );
    return null;
  }

  // ---------------------------------------------------------------------------
  // Unchanged public helpers (API compatibility)
  // ---------------------------------------------------------------------------

  /** Legacy format URL helper kept for API compatibility. */
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
    logger.warn('TrailerService', `getTrailerData: no video ID available for "${title}"`);
    return null;
  }

  static setUseLocalServer(_useLocal: boolean): void {
    logger.info('TrailerService', 'setUseLocalServer: no server used, on-device only');
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
  // Private cache
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
