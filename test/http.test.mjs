import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { deferred, fixture, listen, logger } from './helpers.mjs';

test('GET and POST preserve the success flag and include per-room results', async t => {
  const { service, calls } = fixture();
  const { url } = await listen(t, createApp(service, logger));
  for (const method of ['GET', 'POST']) {
    const response = await fetch(url + '/announce', { method });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { success: true, speakers: [{ zone: 'Living', status: 'announced' }] });
  }
  assert.equal(calls.filter(([stage]) => stage === 'clip').length, 2);
});

test('health checks, HEAD, OPTIONS, subpaths and unsupported methods never announce', async t => {
  const { service, calls } = fixture();
  const { url } = await listen(t, createApp(service, logger));
  for (const [method, path, status] of [['GET', '/health', 200], ['HEAD', '/announce', 204], ['OPTIONS', '/announce', 204],
    ['DELETE', '/announce', 405], ['GET', '/announce/anything', 404], ['GET', '/zones', 404]]) {
    const response = await fetch(url + path, { method });
    assert.equal(response.status, status);
    await response.text();
  }
  assert.deepEqual(calls, []);
});

test('optional authentication rejects missing or wrong tokens before contacting Sonos', async t => {
  const { service, calls } = fixture();
  const { url } = await listen(t, createApp(service, logger, 'test-secret'));
  for (const authorization of ['', 'Bearer wrong-token', 'Basic test-secret']) {
    const response = await fetch(url + '/announce', { headers: { Authorization: authorization } });
    assert.equal(response.status, 401);
    await response.text();
  }
  assert.deepEqual(calls, []);
  const response = await fetch(url + '/announce', { headers: { Authorization: 'Bearer test-secret' } });
  assert.equal(response.status, 200);
  await response.text();
});

test('partial failure returns structured errors and still announces in other rooms', async t => {
  const { service, client, calls } = fixture({ speakers: { Living: { volume: 25 }, Kitchen: { volume: 20 } } });
  const original = client.sendAnnouncement;
  client.sendAnnouncement = async player => {
    if (player.name === 'Kitchen') throw new Error('Sonos rejected the command.');
    return original(player, 25, 'http://announcer.test/doorbell.mp3');
  };
  const { url } = await listen(t, createApp(service, logger));
  const response = await fetch(url + '/announce');
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.equal(result.success, false);
  assert.equal(result.speakers[0].status, 'announced');
  assert.equal(result.speakers[1].errors[0].stage, 'announcement');
  assert.deepEqual(calls, [['discover'], ['clip', 'Living']]);
});

test('concurrent HTTP requests wait for the same announcement result', async t => {
  const playing = deferred();
  const release = deferred();
  let clips = 0;
  const { service } = fixture({ client: { async sendAnnouncement() { clips++; playing.resolve(); await release.promise; } } });
  const app = createApp(service, logger);
  const joined = deferred();
  const original = service.announce.bind(service);
  let requests = 0;
  service.announce = () => { requests++; const pending = original(); if (requests === 2) joined.resolve(); return pending; };
  const { url } = await listen(t, app);
  const first = fetch(url + '/announce');
  await playing.promise;
  const second = fetch(url + '/announce', { method: 'POST' });
  await joined.promise;
  release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(clips, 1);
  assert.deepEqual(await a.json(), await b.json());
});

test('draining service returns 503 for new announcements and health checks', async t => {
  const { service, calls } = fixture();
  const { url } = await listen(t, createApp(service, logger));
  await service.stop();
  for (const path of ['/announce', '/health']) {
    const response = await fetch(url + path);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).success, false);
  }
  assert.deepEqual(calls, []);
});

test('unexpected service rejection becomes a controlled 500 response', async t => {
  const { service } = fixture();
  service.announce = async () => { throw new Error('private internal details'); };
  const { url } = await listen(t, createApp(service, logger));
  const response = await fetch(url + '/announce');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { success: false, error: 'Announcement failed.' });
});
