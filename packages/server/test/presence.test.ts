import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Le module config lit l'environnement a l'import : on le prepare avant.
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'livememes-presence-'));
process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = 'test-client';
process.env.DATA_DIR = tmpData;
process.env.PORT = '0';

const { createApp } = await import('../src/http/app.ts');
const { attachGateway } = await import('../src/realtime/gateway.ts');
const { createPairingCode, redeemPairingCode } = await import('../src/store/devices.ts');
const presence = await import('../src/realtime/presence.ts');
const { WebSocket } = await import('ws');
type ServerMessage = import('@livememes/shared').ServerMessage;
type PresenceMember = import('@livememes/shared').PresenceMember;
type Socket = InstanceType<typeof WebSocket>;

const ALICE = { id: '100000000000000001', username: 'Alice', avatarUrl: null };
const BOB = { id: '100000000000000002', username: 'Bob', avatarUrl: null };
const CHANNEL = '200000000000000001';

let server: Server;
let wsUrl: string;
const sockets: Socket[] = [];

function tokenFor(user: typeof ALICE): string {
  const { code } = createPairingCode(user);
  const device = redeemPairingCode(code, `PC de ${user.username}`);
  assert.ok(device);
  return device.token;
}

/** Ouvre une connexion et enregistre chaque message `presence` recu. */
function connect(token: string): { socket: Socket; next: (match?: (members: PresenceMember[]) => boolean) => Promise<PresenceMember[]> } {
  const socket = new WebSocket(`${wsUrl}?token=${token}`);
  sockets.push(socket);
  const received: PresenceMember[][] = [];
  const waiters: { match: (members: PresenceMember[]) => boolean; resolve: (members: PresenceMember[]) => void }[] = [];

  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw)) as ServerMessage;
    if (message.t !== 'presence') return;
    const waiter = waiters.findIndex((entry) => entry.match(message.members));
    if (waiter >= 0) waiters.splice(waiter, 1)[0]!.resolve(message.members);
    else received.push(message.members);
  });

  return {
    socket,
    next: (match = () => true) =>
      new Promise((resolve, reject) => {
        const index = received.findIndex(match);
        if (index >= 0) return resolve(received.splice(0, index + 1).at(-1)!);
        const timer = setTimeout(() => reject(new Error('Timeout en attendant "presence"')), 3000);
        waiters.push({
          match,
          resolve: (members) => {
            clearTimeout(timer);
            resolve(members);
          },
        });
      }),
  };
}

const stateOf = (members: PresenceMember[], id: string) => members.find((member) => member.id === id)?.state;

before(async () => {
  server = createServer(createApp());
  attachGateway(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

beforeEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  presence.reset();
});

after(() => {
  for (const socket of sockets) socket.close();
  server.close();
  fs.rmSync(tmpData, { recursive: true, force: true });
});

describe('presence', () => {
  it('envoie une liste vide a un utilisateur hors de tout salon', async () => {
    const alice = connect(tokenFor(ALICE));
    assert.deepEqual(await alice.next(), []);
  });

  it('envoie le salon des la connexion, avec l etat de chacun', async () => {
    presence.setChannel(CHANNEL, [
      { id: ALICE.id, avatarUrl: 'https://cdn.example/a.png' },
      { id: BOB.id, avatarUrl: null },
    ]);
    const alice = connect(tokenFor(ALICE));
    const members = await alice.next();
    assert.equal(members.length, 2);
    assert.equal(stateOf(members, ALICE.id), 'online');
    assert.equal(stateOf(members, BOB.id), 'offline');
    assert.equal(members[0]?.avatarUrl, 'https://cdn.example/a.png');
  });

  it('suit connexion, sourdine et deconnexion des autres membres', async () => {
    presence.setChannel(CHANNEL, [
      { id: ALICE.id, avatarUrl: null },
      { id: BOB.id, avatarUrl: null },
    ]);
    const alice = connect(tokenFor(ALICE));
    await alice.next();

    const bob = connect(tokenFor(BOB));
    await alice.next((members) => stateOf(members, BOB.id) === 'online');

    bob.socket.send(JSON.stringify({ t: 'setMuted', muted: true }));
    await alice.next((members) => stateOf(members, BOB.id) === 'muted');

    bob.socket.close();
    await alice.next((members) => stateOf(members, BOB.id) === 'offline');
  });

  it('previent qui entre et qui sort du salon', async () => {
    presence.setChannel(CHANNEL, [{ id: ALICE.id, avatarUrl: null }]);
    const alice = connect(tokenFor(ALICE));
    const bob = connect(tokenFor(BOB));
    await alice.next();
    assert.deepEqual(await bob.next(), []);

    presence.setChannel(CHANNEL, [
      { id: ALICE.id, avatarUrl: null },
      { id: BOB.id, avatarUrl: null },
    ]);
    assert.equal((await bob.next((members) => members.length === 2)).length, 2);
    await alice.next((members) => members.length === 2);

    presence.setChannel(CHANNEL, [{ id: ALICE.id, avatarUrl: null }]);
    assert.deepEqual(await bob.next((members) => members.length === 0), []);
    assert.equal((await alice.next((members) => members.length === 1))[0]?.id, ALICE.id);
  });

  it('regroupe une rafale de changements en un seul message', async () => {
    presence.setChannel(CHANNEL, [{ id: ALICE.id, avatarUrl: null }]);
    const alice = connect(tokenFor(ALICE));
    await alice.next();

    let count = 0;
    alice.socket.on('message', (raw) => {
      if ((JSON.parse(String(raw)) as ServerMessage).t === 'presence') count++;
    });
    for (let i = 0; i < 5; i++) {
      presence.setChannel(CHANNEL, [
        { id: ALICE.id, avatarUrl: null },
        { id: `30000000000000000${i}`, avatarUrl: null },
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, presence.FLUSH_MS + 200));
    assert.equal(count, 1);
  });
});
