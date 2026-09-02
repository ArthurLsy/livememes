# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Langue

Tout le depot est en francais **sans accents** (ASCII pur) : commentaires, logs,
messages d'erreur, reponses du bot, textes de l'UI desktop. Garde cette convention
dans tout code ajoute.

## Commandes

```bash
npm install
cp .env.example .env          # DISCORD_TOKEN et DISCORD_CLIENT_ID obligatoires

npm run dev                   # backend + bot (tsx watch)
npm run dev:desktop           # overlay Electron (esbuild watch + electron)
npm run commands:deploy       # enregistre les slash commands aupres de Discord
npm test                      # tests du serveur
npm run typecheck             # tsc --noEmit sur les deux packages
npm run dist:desktop          # binaire desktop -> packages/desktop/release/
```

Un seul test :

```bash
npx tsx --test --test-name-pattern="livre un drop" packages/server/test/relay.test.ts
```

Docker (backend uniquement) :

```bash
docker compose -f docker-compose.yaml -f docker-compose.local.yaml up -d --build
```

## Chaine de build : il n'y en a pas cote serveur

- Le serveur **n'est jamais compile**. `tsx` transpile les `.ts` a la volee, y
  compris en production (le `CMD` du Dockerfile est `node --import tsx`). `tsc`
  ne sert qu'au typecheck (`noEmit: true` partout).
- Les imports portent l'extension **`.ts` explicite** (`./config.ts`,
  `../store/devices.ts`), autorisee par `allowImportingTsExtensions`. Ecris tes
  imports internes de la meme facon, sinon rien ne resout.
- `@livememes/shared` publie ses **sources TypeScript** (`main` pointe sur
  `src/index.ts`). Chaque consommateur les compile lui-meme : tsx cote serveur,
  esbuild cote desktop.
- Le desktop passe par `packages/desktop/build.mjs` (esbuild) : main et preload
  en CJS bundles vers `dist/`, renderers en IIFE navigateur, `.html/.css/.svg`
  copies tels quels. Electron charge `dist/main/index.cjs`.
- Node 24 est le runtime reel (le Dockerfile l'impose) : `node:sqlite` n'est
  disponible sans flag qu'a partir de 23.4, meme si `engines` tolere 22.5.

## Architecture

```
/meme  ──►  bot Discord  ──►  ingestion media  ──►  hub  ──►  WS  ──►  overlays
           (salon vocal)      (re-heberge)        (par user)        (N ecrans)
```

Le backend est **un seul processus** qui expose HTTP et WebSocket sur le meme
port (8787) : `packages/server/src/index.ts` cree le serveur http, y attache le
gateway WS (`/ws`) et lance le client Discord.

**Serveur** (`packages/server/src/`)

- `config.ts` — lit `.env` **a la racine du repo** (resolu depuis `import.meta.url`,
  pas depuis le cwd) et gele toute la config a l'import. Tout passe par cet objet.
- `bot/commands/` — un module par commande, exportant `data` / `execute` /
  `autocomplete?`. `commands/index.ts` les agrege dans une Map par nom. Ajouter
  ou modifier une commande impose de relancer `npm run commands:deploy`.
- `bot/drop.ts` — coeur du chemin d'envoi : resout le salon vocal de l'auteur,
  ingere le media, construit le `MemeDrop`, diffuse via le hub. Le cooldown par
  utilisateur vit ici, en memoire.
- `media/cache.ts` — telecharge et re-sert tout media. **Indispensable** : les URLs
  du CDN Discord sont signees et expirent, un `MemeDrop.url` doit toujours pointer
  sur `PUBLIC_URL/media/<id>`. Allowlist stricte de content-types (pas de HTML/SVG),
  coupe le stream au-dela de `MEDIA_MAX_BYTES`, purge par mtime.
- `realtime/hub.ts` — registre en memoire des connexions, indexe par utilisateur
  Discord (plusieurs machines par utilisateur). `broadcast()` recoit l'ensemble des
  utilisateurs en sourdine en argument pour eviter un aller-retour SQLite par cible.
- `realtime/gateway.ts` — authentifie sur `?token=`, envoie `hello`, heartbeat ping
  30s, compte les accuses `shown` par drop pendant 60s.
- `store/` — SQLite via `node:sqlite`, schema cree a l'import de `db.ts`. Pas de
  framework de migration : les evolutions de schema s'ecrivent a la main dans ce
  fichier (voir la reprise `user_prefs.user_id` INTEGER -> TEXT). **Les snowflakes
  Discord doivent toujours etre stockes en TEXT**, ils depassent `MAX_SAFE_INTEGER`.

**Desktop** (`packages/desktop/src/`)

- App de barre de menus, sans dock, instance unique. `main/index.ts` cable tray,
  IPC et etat partage avec la fenetre de reglages.
- `main/connection.ts` — WebSocket persistante avec backoff exponentiel. Une erreur
  `unauthorized`/`unlinked` **arrete definitivement** les tentatives et efface le token.
- `main/overlay.ts` — une `BrowserWindow` par ecran cible : transparente, sans focus,
  `setIgnoreMouseEvents(true)` (ne bloque jamais un clic), always-on-top niveau
  `screen-saver` reapplique a chaque drop (un jeu plein ecran peut avoir repris le dessus).
- Renderers sans acces Node : tout passe par le `contextBridge` du preload, et
  toute navigation est bloquee dans `web-contents-created`.

**Protocole** (`packages/shared/src/index.ts`) — source unique de verite pour les
messages WS et le payload d'appairage. Toute evolution incompatible doit bouger
`PROTOCOL_VERSION` ; serveur et overlay sont deployes separement, un overlay
ancien peut se connecter a un serveur recent.

## Pieges

- **`PUBLIC_URL`** : c'est l'URL envoyee aux overlays. Mal reglee, les commandes
  repondent normalement dans Discord mais aucun meme ne s'affiche. En `localhost`,
  seuls les overlays de la machine locale voient quelque chose.
- **Etat en memoire, un seul processus** : hub, cooldowns, codes d'appairage et
  compteurs `shown` ne sont pas partages. Le backend ne se replique pas horizontalement
  en l'etat.
- **`DEPLOY_COMMANDS_ON_BOOT`** doit rester a `false` en dehors du premier
  deploiement : Discord plafonne la creation de commandes globales a 200/jour et un
  conteneur qui redemarre en boucle epuise le quota.
- **Le volume `/app/data`** contient la base des appareils lies. Perdu, tout le monde
  doit refaire `/livememes link`.
- **Tests** : `config.ts` lit l'environnement a l'import. Le fichier de test pose
  ses `process.env` puis charge les modules via `await import()`. Tout nouveau test
  touchant au serveur doit suivre ce schema, sinon la config est deja figee.
- Les tests couvrent appairage, relais et media **sans bot Discord** : ils montent
  l'app Express et le gateway sur un port ephemere. Ne fais pas dependre le code
  testable de `discord.js`.
