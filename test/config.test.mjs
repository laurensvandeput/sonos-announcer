import assert from 'node:assert/strict';
import test from 'node:test';
import { readAppConfig } from '../src/Config/AppConfig.ts';
import { isActiveAtHour, SpeakerConfig } from '../src/Config/SpeakerConfig.ts';
import { livingId } from './sonos-server.mjs';

const env = { SONOS_HOSTS: '10.1.60.156, 10.1.60.216', MEDIA_BASE_URL: 'http://announcer.test:3000/', TIME_ZONE: 'Europe/Brussels' };

test('configuration uses direct Sonos addresses and retains port compatibility', () => {
  const config = readAppConfig(env);
  assert.equal(config.port, 3000);
  assert.deepEqual(config.sonosUrls, ['wss://10.1.60.156:1443/websocket/api', 'wss://10.1.60.216:1443/websocket/api']);
  assert.equal(config.mediaBaseUrl, 'http://announcer.test:3000');
  assert.equal(config.shutdownTimeoutMs, config.requestTimeoutMs * 2 + 5000);
  assert.equal(readAppConfig({ ...env, PORT: '4000' }).port, 4000);
  assert.equal(readAppConfig({ ...env, PORT: '3000', NODE_PORT: '4000' }).port, 4000);
});

test('invalid environment settings fail before startup', () => {
  for (const invalid of [
    { SONOS_HOSTS: ',' }, { SONOS_HOSTS: 'http://localhost:5005' }, { SONOS_HOSTS: 'speaker/path' },
    { SONOS_HOSTS: 'user:secret@speaker' }, { SONOS_HOSTS: 'speaker,' },
    { MEDIA_BASE_URL: 'file:///tmp/test' }, { MEDIA_BASE_URL: 'not-a-url' },
    { MEDIA_BASE_URL: 'http://host/?token=secret' }, { MEDIA_BASE_URL: 'http://user:secret@host' },
    { CLIP_FILE: './clip.wav' }, { PORT: '0' }, { PORT: '65536' }, { PORT: '1.5' }, { PORT: 'abc' },
    { TIME_ZONE: 'not/a/timezone' }, { SONOS_REQUEST_TIMEOUT_MS: '0' },
    { SHUTDOWN_TIMEOUT_MS: '-1' }, { ANNOUNCE_TOKEN: ' token ' },
    { SONOS_DISCOVERY_INTERFACE: 'eth0' }, { SONOS_DISCOVERY_INTERFACE: '192.168.1.1:1900' },
  ]) assert.throws(() => readAppConfig({ ...env, ...invalid }), Error, JSON.stringify(invalid));
});

test('the media address is automatic unless a valid override is supplied', () => {
  for (const MEDIA_BASE_URL of [undefined, '', '  ']) {
    assert.equal(readAppConfig({ ...env, MEDIA_BASE_URL }).mediaBaseUrl, undefined);
  }
  assert.equal(readAppConfig({ ...env, MEDIA_BASE_URL: 'https://media.example.test/prefix/' }).mediaBaseUrl,
    'https://media.example.test/prefix');
});

test('missing or empty Sonos hosts enable automatic discovery', () => {
  for (const SONOS_HOSTS of [undefined, '', '  ']) {
    assert.deepEqual(readAppConfig({ ...env, SONOS_HOSTS }).sonosUrls, []);
  }
  assert.equal(readAppConfig({ ...env, SONOS_DISCOVERY_INTERFACE: '10.1.50.20' }).discoveryInterface, '10.1.50.20');
});

test('speaker mappings, UUIDs, volumes and complete schedules are validated', () => {
  for (const value of [null, [], {}, { speakers: [] }, { speakers: {} }, { speakers: null },
    { speakers: { Room: null } }, ...[
      {}, { uuid: 'Beam', volume: 25 }, { volume: '25' }, { volume: -1 }, { volume: 101 }, { volume: 1.5 },
      { volume: 25, active: { start: 9 } }, { volume: 25, active: { start: 9, end: 9 } },
      { volume: 25, active: { start: 24, end: 7 } },
    ].map(speaker => ({ speakers: { Room: { uuid: livingId, ...speaker } } })),
    { speakers: { '': { uuid: livingId, volume: 25 } } },
    { speakers: { Room: { volume: 25 } } },
    { speakers: { A: { uuid: livingId, volume: 25 }, B: { uuid: livingId.toLowerCase(), volume: 20 } } },
  ]) assert.throws(() => new SpeakerConfig(value));
  const config = new SpeakerConfig({ speakers: { 'Friendly label': { uuid: livingId.toLowerCase(), volume: 25 } } });
  assert.equal(config.getConfig('Friendly label').uuid, livingId);
});

test('daytime and overnight schedules include start and exclude end', () => {
  const day = { volume: 25, active: { start: 9, end: 19 } };
  const night = { volume: 25, active: { start: 22, end: 7 } };
  for (const [hour, expected] of [[8, false], [9, true], [18, true], [19, false]]) {
    assert.equal(isActiveAtHour(day, hour), expected);
  }
  for (const [hour, expected] of [[21, false], [22, true], [23, true], [0, true], [6, true], [7, false]]) {
    assert.equal(isActiveAtHour(night, hour), expected);
  }
  assert.equal(isActiveAtHour({ volume: 0 }, 0), true);
  assert.equal(isActiveAtHour({ volume: 0, active: { start: 0, end: 24 } }, 23), true);
});
