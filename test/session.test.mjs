import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { Session } from '../src/Sonos/Session.ts';
import { SonosClient } from '../src/Sonos/Client.ts';
import { livingId, sonosServer } from './sonos-server.mjs';

const request = { namespace: 'groups:1', command: 'getGroups', householdId: 'test-household' };
const clipUrl = 'http://announcer.test/clip.mp3';

async function sessionFor(t, options = {}, timeout = 1000) {
  const server = await sonosServer(t, options);
  const session = new Session(server.url, timeout);
  t.after(() => session.close());
  return { session, server };
}

test('a refused TCP connection retains its system error code', async () => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const session = new Session('wss://127.0.0.1:' + port + '/websocket/api', 1000);
  try {
    await assert.rejects(session.open(), error => {
      assert.equal(error.code, 'CONNECTION_FAILED');
      assert.equal(error.details.systemCode, 'ECONNREFUSED');
      assert.equal(error.details.phase, 'connect');
      return true;
    });
  } finally { session.close(); }
});

test('handshake rejection is distinguishable from an unreachable speaker', async t => {
  const { session } = await sessionFor(t, { rejectHandshake: true });
  await assert.rejects(session.open(), error => {
    assert.equal(error.code, 'HANDSHAKE_REJECTED');
    assert.equal(error.details.httpStatus, 400);
    return true;
  });
});

test('command timeout records the pending command rather than a playback failure', async t => {
  const { session } = await sessionFor(t, { onCommand: () => true }, 150);
  await session.open();
  await assert.rejects(session.command(request), error => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.details.command, 'getGroups');
    assert.equal(error.details.phase, 'command');
    return true;
  });
});

test('command rejection preserves only a safe Sonos code and no raw response', async t => {
  const { session } = await sessionFor(t, { onCommand({ reply }) {
    reply({ errorCode: 'ERROR_NOT_SUPPORTED', message: 'private response details' }, { success: false, type: 'globalError' });
    return true;
  } });
  await session.open();
  await assert.rejects(session.command(request), error => {
    assert.equal(error.code, 'COMMAND_REJECTED');
    assert.equal(error.details.sonosCode, 'ERROR_NOT_SUPPORTED');
    assert.doesNotMatch(JSON.stringify(error), /private response details/);
    return true;
  });
});

test('transport buffers events from any namespace and rejects competing consumers', async t => {
  const { session } = await sessionFor(t, { onCommand({ reply, socket }) {
    socket.send(JSON.stringify([{ namespace: 'playerVolume:1', name: 'volume', type: 'playerVolume' }, { volume: 20 }]));
    reply(); return true;
  } });
  await session.open();
  await session.command(request);
  assert.equal((await session.nextEvent()).header.namespace, 'playerVolume:1');
  const waiting = session.nextEvent();
  await assert.rejects(session.nextEvent(), { code: 'INVALID_STATE' });
  session.close();
  await assert.rejects(waiting, { code: 'SESSION_CLOSED' });
});

test('mismatched or invalid command responses fail instead of being accepted', async t => {
  for (const extra of [{ success: 'true' }, { response: 'anotherCommand' }, { namespace: 'anotherNamespace' }]) {
    const { session } = await sessionFor(t, { onCommand({ reply }) { reply({}, extra); return true; } });
    await session.open();
    await assert.rejects(session.command(request), { code: 'PROTOCOL_ERROR' });
  }
});

test('connection closure retains the close code without logging the remote reason', async t => {
  const { session } = await sessionFor(t, { onCommand({ socket }) { socket.close(1008, 'private reason'); return true; } });
  await session.open();
  await assert.rejects(session.command(request), error => {
    assert.equal(error.code, 'CONNECTION_CLOSED');
    assert.equal(error.details.closeCode, 1008);
    assert.doesNotMatch(JSON.stringify(error), /private reason/);
    return true;
  });
});

test('invalid status for our own clip is a protocol failure, unrelated events are ignored', async t => {
  const server = await sonosServer(t, { onCommand({ header, reply, socket, status }) {
    if (header.command !== 'loadAudioClip') return;
    reply({ id: 'our-clip' });
    socket.send(JSON.stringify([{ namespace: 'playerVolume:1', type: 'playerVolume', playerId: livingId }, { volume: 30 }]));
    status('FUTURE_STATE', 'another-clip');
    status('INVALID_STATE', 'our-clip');
    return true;
  } });
  const client = new SonosClient([server.url], 1000);
  await assert.rejects(client.sendAnnouncement((await client.discover())[0], 25, clipUrl), { code: 'PROTOCOL_ERROR' });
});
