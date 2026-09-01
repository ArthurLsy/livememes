import { config } from '../config.ts';

export interface TenorGif {
  id: string;
  title: string;
  /** MP4 quand il existe (bien plus leger qu'un GIF), sinon le GIF. */
  url: string;
}

interface TenorResponse {
  results?: Array<{
    id: string;
    title?: string;
    content_description?: string;
    media_formats?: Record<string, { url?: string }>;
  }>;
}

export const tenorEnabled = (): boolean => config.tenor.apiKey !== null;

/** Formats par ordre de preference : leger d'abord, GIF en dernier recours. */
const FORMATS = ['tinymp4', 'mp4', 'tinygif', 'mediumgif', 'gif'] as const;

function pickUrl(formats: Record<string, { url?: string }> | undefined): string | null {
  if (!formats) return null;
  for (const name of FORMATS) {
    const url = formats[name]?.url;
    if (url) return url;
  }
  return null;
}

async function call(endpoint: string, params: Record<string, string>): Promise<TenorGif[]> {
  if (!config.tenor.apiKey) return [];

  const url = new URL(`https://tenor.googleapis.com/v2/${endpoint}`);
  url.searchParams.set('key', config.tenor.apiKey);
  url.searchParams.set('client_key', config.tenor.clientKey);
  url.searchParams.set('media_filter', FORMATS.join(','));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`Tenor a repondu ${response.status}`);

  const data = (await response.json()) as TenorResponse;
  const gifs: TenorGif[] = [];
  for (const result of data.results ?? []) {
    const mediaUrl = pickUrl(result.media_formats);
    if (!mediaUrl) continue;
    gifs.push({
      id: result.id,
      title: result.title || result.content_description || 'GIF',
      url: mediaUrl,
    });
  }
  return gifs;
}

/** Utilise par l'autocompletion de /meme search. */
export function search(query: string, limit = 20): Promise<TenorGif[]> {
  return call('search', { q: query, limit: String(limit), contentfilter: 'medium' });
}

/** Resout l'ID choisi dans l'autocompletion vers une URL de media. */
export async function byId(id: string): Promise<TenorGif | null> {
  const [gif] = await call('posts', { ids: id, limit: '1' });
  return gif ?? null;
}
