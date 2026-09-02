import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GuildMember, VoiceBasedChannel } from 'discord.js';

// Le module config lit l'environnement a l'import : on le prepare avant. Ce
// fichier tourne dans son propre processus, DROP_ROLE_ID n'affecte pas les
// autres tests.
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'livememes-test-'));
process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = 'test-client';
process.env.DATA_DIR = tmpData;
process.env.PORT = '0';

const ROLE = '999000111222333444';
process.env.DROP_ROLE_ID = ROLE;

const { audienceOf, hasDropRole, humansOf } = await import('../src/bot/drop.ts');

/** Membre minimal : seuls user.bot et roles.cache sont lus par le filtrage. */
function member(id: string, options: { bot?: boolean; roles?: string[] } = {}): GuildMember {
  return {
    id,
    user: { bot: options.bot ?? false },
    roles: { cache: new Map((options.roles ?? []).map((role) => [role, {}])) },
  } as unknown as GuildMember;
}

function voiceChannel(...members: GuildMember[]): VoiceBasedChannel {
  return {
    members: new Map(members.map((entry) => [entry.id, entry])),
  } as unknown as VoiceBasedChannel;
}

describe('role requis pour les memes', () => {
  it('reconnait le porteur du role', () => {
    assert.equal(hasDropRole(member('1', { roles: [ROLE] })), true);
    assert.equal(hasDropRole(member('2', { roles: ['un-autre-role'] })), false);
    assert.equal(hasDropRole(member('3')), false);
  });

  it('retire de l audience les membres sans le role', () => {
    const channel = voiceChannel(
      member('1', { roles: [ROLE] }),
      member('2'),
      member('3', { roles: [ROLE, 'un-autre-role'] }),
    );

    assert.deepEqual(
      audienceOf(channel).map((entry) => entry.id),
      ['1', '3'],
    );
  });

  it('compte les humains presents, role ou pas, pour /livememes status', () => {
    const channel = voiceChannel(
      member('1', { roles: [ROLE] }),
      member('2'),
      member('bot', { bot: true, roles: [ROLE] }),
    );

    assert.equal(humansOf(channel).length, 2);
    assert.equal(audienceOf(channel).length, 1);
  });

  it('ignore les bots meme quand ils portent le role', () => {
    const channel = voiceChannel(member('bot', { bot: true, roles: [ROLE] }));
    assert.deepEqual(audienceOf(channel), []);
  });
});
