import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LibraryVideo } from '@livememes/shared';
import { filterLibrary, normalize, titleFromName } from '../src/renderer/library-model.ts';

const video = (id: string, title: string, tags: string[] = []): LibraryVideo => ({
  id,
  title,
  tags,
  url: `https://memes.example/library/${id}`,
  contentType: 'video/mp4',
  bytes: 1000,
});

const videos = [
  video('chat', 'Chat surpris', ['chat', 'reaction']),
  video('foule', 'Foule en délire', ['sport', 'joie']),
  video('bruh', 'Bruh', ['reaction']),
];

describe('banque de memes', () => {
  it('normalise casse et accents', () => {
    assert.equal(normalize('  Réaction DÉLIRE '), 'reaction delire');
  });

  it('renvoie tout le catalogue sans recherche', () => {
    assert.equal(filterLibrary(videos, '   ').length, 3);
  });

  it('cherche dans le titre et les tags, sans accents', () => {
    assert.deepEqual(filterLibrary(videos, 'delire').map((entry) => entry.id), ['foule']);
    assert.deepEqual(filterLibrary(videos, 'réaction').map((entry) => entry.id), ['chat', 'bruh']);
  });

  it('exige tous les mots de la recherche', () => {
    assert.deepEqual(filterLibrary(videos, 'reaction chat').map((entry) => entry.id), ['chat']);
    assert.deepEqual(filterLibrary(videos, 'reaction sport'), []);
  });
});

describe('titre propose pour la banque', () => {
  it('part du nom de fichier, sans extension ni numero de copie', () => {
    assert.equal(titleFromName('chat_surpris-final (1).mp4'), 'chat surpris final');
    assert.equal(titleFromName('Foule.en.delire.mov'), 'Foule en delire');
  });
});
