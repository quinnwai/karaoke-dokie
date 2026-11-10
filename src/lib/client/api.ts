// The screen's only door to the HTTP API. Paths and shapes follow src/lib/contracts.ts.

import type {
  FeedbackRequest,
  KnownSongsResponse,
  MeResponse,
  RecommendationsResponse,
  VocalRange,
} from '../contracts';

export const LOGIN_PATH = '/api/auth/login';
export const PAGE_SIZE = 5;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`${path} failed with ${status}`);
  }
}

export interface Api {
  /** The signed-in user, or null when signed out (401). */
  me(): Promise<MeResponse | null>;
  saveRange(range: VocalRange): Promise<void>;
  recommendations(offset: number, limit?: number): Promise<RecommendationsResponse>;
  knownSongs(): Promise<KnownSongsResponse>;
  feedback(body: FeedbackRequest): Promise<void>;
}

type Fetch = typeof fetch;

export function createApi(fetchImpl: Fetch = (...args) => fetch(...args)): Api {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(path, {
      credentials: 'same-origin',
      ...init,
      headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    });
    if (!res.ok) throw new ApiError(res.status, path);
    return (await res.json()) as T;
  }

  return {
    async me() {
      try {
        return await call<MeResponse>('/api/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    async saveRange(range) {
      await call('/api/me/range', { method: 'PUT', body: JSON.stringify(range) });
    },
    recommendations(offset, limit = PAGE_SIZE) {
      return call<RecommendationsResponse>(`/api/recommendations?offset=${offset}&limit=${limit}`);
    },
    knownSongs() {
      return call<KnownSongsResponse>('/api/songs/known');
    },
    async feedback(body) {
      await call('/api/feedback', { method: 'POST', body: JSON.stringify(body) });
    },
  };
}
