# Image du backend LiveMemes : bot Discord + API HTTP + relais WebSocket.
# L'app desktop n'est pas concernee, elle se construit a part (npm run dist:desktop).

# Node 24+ est requis : le backend utilise node:sqlite, disponible sans flag
# seulement a partir de Node 23.4.
FROM node:24-alpine AS deps

WORKDIR /app
ENV npm_config_update_notifier=false

# Les manifests d'abord : cette couche n'est reconstruite qu'au changement de deps.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/desktop/package.json packages/desktop/

# --ignore-scripts empeche le postinstall d'Electron de telecharger 200 Mo de binaire
# pour rien (il est en devDependency du package desktop, hors scope de cette image).
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---------------------------------------------------------------------------

FROM node:24-alpine

# tini comme PID 1 : sans lui, le conteneur ne transmet pas SIGTERM et
# l'arret propre du serveur (fermeture des WebSockets) ne se declenche jamais.
RUN apk add --no-cache tini

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/app/data

# Recupere node_modules a tous les niveaux du workspace, symlinks inclus.
COPY --from=deps --chown=node:node /app /app

COPY --chown=node:node packages/shared packages/shared
COPY --chown=node:node packages/server packages/server

# La base SQLite (tokens des appareils) et le cache media vivent ici.
# A monter sur un volume persistant, sinon tout le monde doit relier son overlay
# a chaque redeploiement.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]

# node directement plutot que npm : npm en tete de chaine avale les signaux.
# tsx transpile les sources TypeScript a la volee (c'est une dependance de prod).
CMD ["node", "--import", "tsx", "packages/server/src/index.ts"]
