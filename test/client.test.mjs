import assert from 'node:assert/strict';
import test from 'node:test';
import { SonosClient } from '../src/Sonos/Client.ts';
import { deferred } from './helpers.mjs';
import { livingId, sonosServer } from './sonos-server.mjs';

const clipUrl = 'http://announcer.test/clips/doorbell.mp3';
const media = { urlFor: () => clipUrl };

test('discovers renamed speakers by UUID and waits for their own clip to finish', async t => {
  const playing = deferred();
  const finish = deferred();
  const server = await sonosServer(t, { onCommand({ header, body, reply, status }) {
    if (header.command !== 'loadAudioClip') return;
    assert.equal(body.streamUrl, clipUrl);
    assert.equal(body.volume, 0); // Zero must not accidentally become the player's current volume.
    assert.equal(body.clipType, undefined);
    reply({ id: 'our-clip' }, { type: 'audioClip' });
    status('DONE', 'someone-elses-clip');
    status('DONE', 'our-clip', 'another-player');
    status('ACTIVE');
    playing.resolve();
    finish.promise.then(() => status('DONE'));
    return true;
  } });
  const client = new SonosClient([server.url], 2000);
  const [player] = await client.discover();
  assert.equal(player.id, livingId);
  assert.equal(player.name, 'New living room name');
  assert.equal(player.supportsAudioClip, true);
  let settled = false;
  const announcement = client.sendAnnouncement(player, 0, media).then(() => { settled = true; });
  await playing.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish.resolve();
  await announcement;
  assert.deepEqual(server.calls.map(({ header }) => header.command),
    [undefined, 'getGroups', undefined, 'getGroups', 'subscribe', 'loadAudioClip']);
});

test('a silent discovery seed does not delay an available seed', async t => {
  const stuck = await sonosServer(t, { onCommand: () => true });
  const available = await sonosServer(t);
  const client = new SonosClient([stuck.url, available.url], 5000);
  const players = await Promise.race([client.discover(), new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Discovery waited for an offline seed.')), 1000);
    timer.unref();
  })]);
  assert.equal(players[0].id, livingId);
});

test('completion events received before the acknowledgement are retained', async t => {
  const server = await sonosServer(t, { onCommand({ header, reply, status }) {
    if (header.command !== 'loadAudioClip') return;
    status('ACTIVE'); status('DONE'); reply({ id: 'our-clip' });
    return true;
  } });
  const client = new SonosClient([server.url], 1000);
  await client.sendAnnouncement((await client.discover())[0], 25, media);
});

for (const state of ['ERROR', 'DISMISSED', 'INTERRUPTED']) {
  test('reports terminal clip state ' + state, async t => {
    const server = await sonosServer(t, { onCommand({ header, reply, status }) {
      if (header.command !== 'loadAudioClip') return;
      reply({ id: 'our-clip' }); status(state); return true;
    } });
    const client = new SonosClient([server.url], 1000);
    await assert.rejects(client.sendAnnouncement((await client.discover())[0], 25, media), new RegExp(state));
  });
}

test('an acknowledgement alone is not success; timeout closes the socket without retrying', async t => {
  const server = await sonosServer(t, { onCommand({ header, reply }) {
    if (header.command !== 'loadAudioClip') return;
    reply({ id: 'our-clip' }); return true;
  } });
  const client = new SonosClient([server.url], 150);
  await assert.rejects(client.sendAnnouncement((await client.discover())[0], 25, media), error => {
    assert.equal(error.code, 'CLIP_TIMEOUT');
    assert.equal(error.details.phase, 'event');
    return true;
  });
  assert.equal(server.calls.filter(({ header }) => header.command === 'loadAudioClip').length, 1);
});

test('a stale IP or unsupported speaker never receives a playback command', async t => {
  for (const invalid of ['identity', 'capability']) {
    const server = await sonosServer(t);
    const client = new SonosClient([server.url], 1000);
    const [player] = await client.discover();
    if (invalid === 'identity') server.player.id = server.player.devices[0].id = 'RINCON_00000000000101400';
    else server.player.devices[0].capabilities = ['PLAYBACK'];
    await assert.rejects(client.sendAnnouncement(player, 25, media), /UUID|AUDIO_CLIP/);
    assert.equal(server.calls.some(({ header }) => header.command === 'loadAudioClip'), false);
  }
});

test('command errors, malformed JSON and unexpected disconnects fail without leaking bodies', async t => {
  for (const action of ['error', 'json', 'close', 'missing-id']) {
    const server = await sonosServer(t, { onCommand({ header, reply, socket }) {
      if (header.command !== 'loadAudioClip') return;
      if (action === 'error') reply({ secret: 'private details' }, { success: false, type: 'globalError' });
      if (action === 'json') socket.send('not json: private details');
      if (action === 'close') socket.close();
      if (action === 'missing-id') reply({});
      return true;
    } });
    const client = new SonosClient([server.url], 1000);
    await assert.rejects(client.sendAnnouncement((await client.discover())[0], 25, media), error => {
      assert.doesNotMatch(error.message, /private details/); return true;
    });
  }
});

test('all unavailable discovery seeds produce a controlled discovery error', async t => {
  const server = await sonosServer(t, { onCommand: () => true });
  await assert.rejects(new SonosClient([server.url], 100).discover(), /Could not discover/);
});
