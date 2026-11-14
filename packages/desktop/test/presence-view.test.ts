import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PresenceMember, PresenceState } from '@livememes/shared';
import { MAX_AVATARS, presenceView } from '../src/renderer/presence-view.ts';

const member = (id: string, state: PresenceState = 'online'): PresenceMember => ({ id, avatarUrl: null, state });

describe('presenceView', () => {
  it('masque la colonne hors salon ou seul dans le salon', () => {
    assert.equal(presenceView([], 'moi'), null);
    assert.equal(presenceView([member('moi')], 'moi'), null);
  });

  it('ne s affiche pas soi-meme', () => {
    const view = presenceView([member('moi'), member('a')], 'moi');
    assert.deepEqual(view?.shown.map((entry) => entry.id), ['a']);
  });

  it('range en ligne, puis sourdine, puis sans overlay, ordre du serveur garde', () => {
    const view = presenceView(
      [member('x', 'offline'), member('b', 'online'), member('m', 'muted'), member('a', 'online')],
      'moi',
    );
    assert.deepEqual(view?.shown.map((entry) => entry.id), ['b', 'a', 'm', 'x']);
  });

  it('resume les gros salons en +N sans jamais afficher +1', () => {
    const many = Array.from({ length: 12 }, (_, i) => member(`u${i}`));
    const view = presenceView(many, null);
    assert.equal(view?.shown.length, MAX_AVATARS - 1);
    assert.equal(view?.hidden, 12 - (MAX_AVATARS - 1));

    const exact = presenceView(many.slice(0, MAX_AVATARS), null);
    assert.equal(exact?.shown.length, MAX_AVATARS);
    assert.equal(exact?.hidden, 0);
  });
});
