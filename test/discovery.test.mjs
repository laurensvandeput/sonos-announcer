import assert from 'node:assert/strict';
import test from 'node:test';
import { SonosClient } from '../src/Sonos/Client.ts';
import { AnnounceService } from '../src/Service/Announce.service.ts';
import { SpeakerConfig } from '../src/Config/SpeakerConfig.ts';
import { createApp } from '../src/app.ts';
import { listen, logger } from './helpers.mjs';
import { kitchenId, livingId, sonosServer } from './sonos-server.mjs';

const clipUrl = 'http://announcer.test/clip.mp3';

test('a malformed configured speaker fails individually while the healthy speaker announces over HTTP', async t => {
  const warnings = [];
  const diagnostics = { ...logger, warn(message, details) { warnings.push({ message, details }); } };
  const server = await sonosServer(t, { onCommand({ header, reply, player }) {
    if (header.command !== 'getGroups') return;
    reply({ players: [null, player, { id: kitchenId, name: 'Kitchen', capabilities: ['AUDIO_CLIP'] }] });
    return true;
  } });
  const client = new SonosClient([server.url], 1000, diagnostics);
  const service = new AnnounceService(client, new SpeakerConfig({ speakers: {
    Living: { uuid: livingId, volume: 25 }, Kitchen: { uuid: kitchenId, volume: 30 },
  } }), clipUrl, diagnostics, 'Europe/Brussels');
  const { url } = await listen(t, createApp(service, diagnostics));
  const response = await fetch(url + '/announce');
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.equal(result.speakers[0].status, 'announced');
  assert.equal(result.speakers[1].errors[0].code, 'PLAYER_NOT_FOUND');
  assert.equal(server.calls.filter(({ header }) => header.command === 'loadAudioClip').length, 1);
  assert.ok(warnings.some(({ details }) => details.playerId === kitchenId && details.reason === 'invalid_address'));
});

test('discovery tolerates unrelated malformed fields and missing display names', async t => {
  const server = await sonosServer(t, { onCommand({ header, reply, player }) {
    if (header.command !== 'getGroups') return;
    reply({ players: [
      { ...player, name: undefined },
      { ...player, id: 'garbage' },
      { ...player, id: kitchenId, websocketUrl: 'https://secret@example.test/private' },
      { id: 'RINCON_00000000000101400', websocketUrl: player.websocketUrl, capabilities: ['PLAYBACK'] },
      { id: 'RINCON_00000000000201400', websocketUrl: player.websocketUrl, capabilities: 'AUDIO_CLIP' },
    ] });
    return true;
  } });
  const players = await new SonosClient([server.url], 1000).discover();
  assert.deepEqual(players.map(player => [player.id, player.name, player.supportsAudioClip]), [
    [livingId, livingId, true], ['RINCON_00000000000101400', 'RINCON_00000000000101400', false],
  ]);
});

test('duplicate UUIDs are excluded completely instead of selecting an arbitrary device', async t => {
  const server = await sonosServer(t, { onCommand({ header, reply, player }) {
    if (header.command !== 'getGroups') return;
    reply({ players: [player,
      { ...player, id: kitchenId, capabilities: ['AUDIO_CLIP'] },
      { ...player, id: kitchenId.toLowerCase(), websocketUrl: 'wss://other.test:1443/websocket/api' },
    ] });
    return true;
  } });
  assert.deepEqual((await new SonosClient([server.url], 1000).discover()).map(player => player.id), [livingId]);
});

test('a seed with no usable players cannot beat a valid discovery response', async t => {
  const broken = await sonosServer(t, { onCommand({ header, reply }) {
    if (header.command !== 'getGroups') return;
    reply({ players: [null, { id: livingId }] }); return true;
  } });
  const available = await sonosServer(t);
  const [player] = await new SonosClient([broken.url, available.url], 1000).discover();
  assert.equal(player.websocketUrl, available.url);
});

test('discovery retains individual seed failure codes and HTTP status for diagnosis', async t => {
  const rejected = await sonosServer(t, { rejectHandshake: true });
  const invalid = await sonosServer(t, { onCommand({ header, reply }) {
    if (header.command !== 'getGroups') return;
    reply({ players: [] }); return true;
  } });
  await assert.rejects(new SonosClient([rejected.url, invalid.url], 1000).discover(), error => {
    assert.equal(error.code, 'DISCOVERY_FAILED');
    assert.deepEqual(error.details.attempts.map(attempt => attempt.code), ['HANDSHAKE_REJECTED', 'PROTOCOL_ERROR']);
    assert.equal(error.details.attempts[0].details.httpStatus, 400);
    return true;
  });
});
