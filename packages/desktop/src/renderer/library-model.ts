/**
 * Banque de memes video (#28), sans DOM : recherche dans le catalogue, partagee
 * par l'editeur et les tests.
 */
import type { LibraryVideo } from '@livememes/shared';

/** Minuscules sans accents : "Reaction" trouve "reaction" et "réaction". */
export function normalize(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Videos dont le titre ou les tags contiennent tous les mots de la recherche,
 * dans l'ordre du catalogue. Recherche vide : tout le catalogue.
 */
export function filterLibrary(videos: readonly LibraryVideo[], query: string): LibraryVideo[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...videos];
  return videos.filter((video) => {
    const haystack = normalize([video.title, ...video.tags].join(' '));
    return words.every((word) => haystack.includes(word));
  });
}
