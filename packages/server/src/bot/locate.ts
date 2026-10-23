import type { Client } from 'discord.js';
import { audienceOf, hasDropRole, type LocateSender } from './drop.ts';

/**
 * Retrouve le salon vocal d'un utilisateur dans les serveurs du bot. Les voice
 * states sont en cache grace a l'intent GuildVoiceStates : aucun appel API,
 * sauf pour un membre absent du cache.
 */
export function senderLocator(client: Client): LocateSender {
  return async (userId) => {
    for (const guild of client.guilds.cache.values()) {
      const state = guild.voiceStates.cache.get(userId);
      if (!state?.channel) continue;

      const member = state.member ?? (await guild.members.fetch(userId).catch(() => null));
      if (!member) continue;
      // Meme regle que /meme : sans le role, l'envoi est refuse.
      if (!hasDropRole(member)) return { ok: false, reason: 'no-role' };

      return {
        ok: true,
        channelName: state.channel.name,
        sender: {
          author: {
            id: member.id,
            username: member.user.displayName || member.user.username,
            avatarUrl: member.user.displayAvatarURL({ size: 64, extension: 'png' }),
          },
          guildName: guild.name,
          audience: audienceOf(state.channel).map((entry) => entry.id),
        },
      };
    }
    return { ok: false, reason: 'not-in-voice' };
  };
}
