import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isClientMessage } from '../src/index.ts';

describe('isClientMessage', () => {
  it('accepte les messages valides', () => {
    assert.ok(isClientMessage({ t: 'ping', ts: Date.now() }));
    assert.ok(isClientMessage({ t: 'shown', dropId: '7f9c0d3e-2b1a-4c5d-9e8f-0a1b2c3d4e5f' }));
    assert.ok(isClientMessage({ t: 'setMuted', muted: true }));
    assert.ok(isClientMessage({ t: 'setMuted', muted: false }));
  });

  it('refuse ce qui n est pas un objet', () => {
    for (const value of [null, undefined, 42, 'ping', true, []]) {
      assert.equal(isClientMessage(value), false, JSON.stringify(value));
    }
  });

  it('refuse un type inconnu ou absent', () => {
    assert.equal(isClientMessage({}), false);
    assert.equal(isClientMessage({ t: 'drop', drop: {} }), false);
    assert.equal(isClientMessage({ t: 'PING', ts: 1 }), false);
  });

  it('refuse un message aux champs manquants ou mal types', () => {
    const invalid = [
      { t: 'ping' },
      { t: 'ping', ts: '123' },
      { t: 'ping', ts: Number.NaN },
      { t: 'ping', ts: Number.POSITIVE_INFINITY },
      { t: 'shown' },
      { t: 'shown', dropId: 42 },
      { t: 'shown', dropId: '' },
      { t: 'shown', dropId: 'x'.repeat(65) },
      { t: 'setMuted' },
      { t: 'setMuted', muted: 'true' },
      { t: 'setMuted', muted: 1 },
    ];
    for (const value of invalid) {
      assert.equal(isClientMessage(value), false, JSON.stringify(value));
    }
  });
});
