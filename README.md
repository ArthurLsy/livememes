# LiveMemes

Balance un meme depuis Discord, il s'affiche **en plein ecran chez tous les membres
du salon vocal** — par-dessus le jeu, le navigateur, n'importe quoi. Dans l'esprit
de MemeDrop.

```
/meme gif recherche:chat qui tape au clavier
        │
        ▼
   bot Discord ──► backend ──► WebSocket ──► overlay Electron (x N personnes)
```

## Comment ca marche

1. Le bot regarde dans **quel salon vocal** se trouve l'auteur de la commande.
2. Il resout le meme (URL ou piece jointe) et le **telecharge sur le backend** —
   les URLs du CDN Discord expirent, on ne peut pas les envoyer telles quelles.
3. Il pousse le meme via WebSocket a **tous les membres du vocal** qui ont l'overlay
   ouvert et lie a leur compte Discord.
4. L'overlay affiche le meme dans une fenetre transparente, toujours au premier plan,
   et **traversante par la souris** : ca ne bloque jamais un clic.

## Structure

| Package | Role |
| --- | --- |
| `packages/shared` | Le protocole WebSocket, partage par les deux cotes |
| `packages/server` | Bot Discord + API HTTP + relais WebSocket + cache media |
| `packages/desktop` | L'overlay Electron (barre de menus, transparent, always-on-top) |

## Installation

```bash
npm install
cp .env.example .env   # puis remplis DISCORD_TOKEN et DISCORD_CLIENT_ID
```

### Creer l'application Discord

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. Onglet **Bot** → *Reset Token* → colle-le dans `DISCORD_TOKEN`
3. Onglet **General Information** → *Application ID* → `DISCORD_CLIENT_ID`
4. Onglet **Installation** → coche `applications.commands` et `bot`, permission
   *Send Messages* → utilise le lien d'installation genere pour inviter le bot

Aucun intent privilegie n'est necessaire : le bot utilise `Guilds` et
`GuildVoiceStates`, tous deux publics.

Mets `DISCORD_DEV_GUILD_ID` pendant le developpement : les commandes apparaissent
instantanement sur ce serveur, au lieu d'attendre jusqu'a une heure en global.

## Lancer

```bash
npm run commands:deploy   # une fois, et a chaque changement de commande
npm run dev               # backend + bot
npm run dev:desktop       # overlay (autre terminal)
```

L'overlay vise `https://meme.gowey.fr` par defaut. Pour le brancher sur un backend
local, lance-le avec `LIVEMEMES_SERVER=http://localhost:8787 npm run dev:desktop` :
c'est la seule facon de changer de serveur, l'URL n'est plus saisissable dans l'app.

L'overlay s'ouvre sur l'ecran de reglages. Dans Discord, fais `/livememes link`,
colle le code, c'est lie.

> **`PUBLIC_URL` compte.** C'est l'URL que les overlays utilisent pour telecharger
> les medias. En `localhost`, seuls les overlays de ta propre machine verront
> quelque chose. Pour tester a plusieurs, expose le backend (Cloudflare Tunnel,
> ngrok, un VPS) et mets cette URL dans `PUBLIC_URL`.

## Heberger le backend

Le backend est la seule partie a heberger : il fait tourner le bot, le relais
WebSocket et le cache media. L'overlay se contente de s'y connecter. Il tient
dans ~150 Mo de RAM, HTTP et WebSocket partagent le port **8787**.

### Coolify

1. **New Resource → Docker Compose**, pointe sur ce depot, fichier
   `docker-compose.yaml`.
2. **Environment Variables** — les trois obligatoires :

   | Variable | Valeur |
   | --- | --- |
   | `DISCORD_TOKEN` | Le token du bot |
   | `DISCORD_CLIENT_ID` | L'Application ID |
   | `PUBLIC_URL` | `https://ton-domaine` — exactement le domaine de l'etape 3 |

3. **Domains** — attache un domaine au service `server`, port `8787`. Coolify
   pose le TLS et route via son proxy. Le WebSocket (`/ws`) passe par la meme
   route, sans configuration supplementaire.
4. **Premier deploiement** : mets `DEPLOY_COMMANDS_ON_BOOT=true` pour enregistrer
   les slash commands automatiquement, puis **repasse-le a `false`** (Discord
   plafonne la creation de commandes globales a 200/jour, et un conteneur qui
   redemarre en boucle epuiserait le quota). Sinon, lance
   `npm run commands:deploy` une fois depuis le terminal Coolify.
5. L'app desktop pointe sur `https://meme.gowey.fr`, fige dans `SERVER_URL`
   (`packages/desktop/src/main/store.ts`). Un autre domaine impose de changer
   cette constante et de reconstruire le client.

> **Le volume `livememes-data` n'est pas optionnel.** Il contient la base SQLite
> des appareils lies. S'il disparait, tout le monde doit refaire
> `/livememes link`. Ne coche pas la suppression des volumes au redeploiement.

`PUBLIC_URL` est l'autre piege : c'est l'URL que les overlays utilisent pour
telecharger les medias. Si elle ne correspond pas au domaine reellement servi,
les commandes repondent normalement dans Discord mais aucun meme ne s'affiche.

### Sans Coolify

```bash
docker compose -f docker-compose.yaml -f docker-compose.local.yaml up -d --build
```

Le second fichier publie le port sur l'hote — inutile, et deconseille, derriere
un proxy qui gere deja le TLS.

### Dimensionnement

Le cache media grossit avec l'usage et se purge tout seul selon
`MEDIA_TTL_HOURS` (24h par defaut). Quelques Go de volume suffisent largement.

## Commandes

### `/meme` — balance un meme dans ton salon vocal

| Sous-commande | Ce que ca fait |
| --- | --- |
| `/meme url url:<lien>` | Une image, un GIF ou une video depuis une URL |
| `/meme fichier fichier:<upload>` | Un fichier depuis ton disque |

Options communes : `texte` (legende), `duree` (secondes), `taille`
(petit/moyen/grand/plein ecran), `position` (centre, coins, aleatoire), `volume`.

### Restreindre a un role

`DROP_ROLE_ID` limite les memes aux porteurs d'un role, **a l'envoi comme a la
reception** : sans le role, `/meme` est refuse et rien ne s'affiche a l'ecran, meme
en etant dans le bon salon vocal. Non definie, la variable laisse tout le monde
eligible. `/livememes status` indique combien de membres du vocal sont exclus.

### `/livememes` — gerer ton overlay

| Sous-commande | Ce que ca fait |
| --- | --- |
| `link` | Donne un code d'appairage a coller dans l'app |
| `devices` | Liste tes appareils lies et leur etat |
| `unlink` | Delie tous tes appareils |
| `mute` | Coupe / reactive la reception des memes |
| `clear` | Efface les memes affiches (tout le vocal si tu es moderateur) |
| `status` | Qui, dans ton vocal, peut recevoir des memes |

## Construire l'app desktop

```bash
npm run dist:desktop   # -> packages/desktop/release/
```

Cible ta plateforme courante. Les binaires ne sont pas signes : macOS et Windows
afficheront un avertissement au premier lancement.

## Tests

```bash
npm test
```

Couvre l'appairage, le relais WebSocket (livraison multi-ecrans, sourdine, cibles
hors ligne) et le service de medias, sans avoir besoin d'un vrai bot Discord.

## Limites connues

- **macOS, jeux en vrai plein ecran** : l'overlay s'affiche au-dessus des apps
  plein ecran natives, mais un jeu qui prend un mode video exclusif peut passer
  devant. Le mode fenetre sans bordure marche toujours.
- **Wayland (Linux)** : le positionnement des fenetres always-on-top est a la main
  du compositeur. X11 fonctionne de maniere fiable.
- **Pas de moderation automatique** du contenu. Le cooldown (`DROP_COOLDOWN_MS`),
  `DROP_ROLE_ID`, `/livememes mute` et `/livememes clear` sont les garde-fous fournis.
- Les tokens d'appareil sont stockes en clair dans la base SQLite du backend et dans
  `settings.json` cote client. Suffisant pour un serveur entre amis ; a durcir si tu
  ouvres le service.
