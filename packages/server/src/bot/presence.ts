import { Events, type Client, type VoiceBasedChannel } from 'discord.js';
import * as presence from '../realtime/presence.ts';
import { audienceOf } from './drop.ts';

/** Declare a la colonne de presence les membres eligibles d'un salon vocal. */
function declare(channel: VoiceBasedChannel): void {
  presence.setChannel(
    channel.id,
    audienceOf(channel).map((member) => ({
      id: member.id,
      avatarUrl: member.displayAvatarURL({ size: 64, extension: 'png' }),
    })),
  );
}

/**
 * Alimente la colonne de presence (#22) a partir des voice states, deja en
 * cache grace a l'intent GuildVoiceStates.
 */
export function trackVoicePresence(client: Client): void {
  // Au demarrage (ou a une reconnexion complete) : etat de tous les salons.
  client.on(Events.ClientReady, (ready) => {
    for (const guild of ready.guilds.cache.values()) {
      const seen = new Set<string>();
      for (const state of guild.voiceStates.cache.values()) {
        if (!state.channel || seen.has(state.channel.id)) continue;
        seen.add(state.channel.id);
        declare(state.channel);
      }
    }
  });

  // Entree, sortie, changement de salon. Les autres changements (micro coupe,
  // camera...) redeclarent aussi le salon : de quoi rattraper un role ou un
  // avatar modifie, sans l'intent privilegie GuildMembers.
  client.on(Events.VoiceStateUpdate, (before, after) => {
    if (before.channel && before.channelId !== after.channelId) declare(before.channel);
    if (after.channel) declare(after.channel);
  });
}
