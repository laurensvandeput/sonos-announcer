import assert from 'node:assert/strict';
import test from 'node:test';
import { ShuttingDownError } from '../src/Service/Announce.service.ts';
import { deferred, fixture } from './helpers.mjs';

test('announces only rooms inside their active hours', async () => {
  const { service, calls } = fixture({ speakers: {
    Living: { volume: 25 }, Quiet: { volume: 10, active: { start: 22, end: 7 } },
  } });
  assert.deepEqual(await service.announce(), { success: true, speakers: [
    { zone: 'Living', status: 'announced' },
    { zone: 'Quiet', status: 'skipped', reason: 'outside_active_hours' },
  ] });
  assert.deepEqual(calls, [['discover'], ['clip', 'Living']]);
});

test('renaming a speaker preserves its selection by UUID and response label', async () => {
  const { service, players, calls } = fixture();
  players[0].name = 'Renamed by household';
  const result = await service.announce();
  assert.deepEqual(result.speakers, [{ zone: 'Living', status: 'announced' }]);
  assert.deepEqual(calls, [['discover'], ['clip', 'Renamed by household']]);
});

test('overlapping requests share one operation until playback completes', async () => {
  const playing = deferred();
  const release = deferred();
  let clips = 0;
  const { service } = fixture({ client: {
    async sendAnnouncement() { clips++; playing.resolve(); await release.promise; },
  } });
  const first = service.announce();
  await playing.promise;
  assert.equal(service.announce(), first);
  assert.equal(clips, 1);
  release.resolve();
  assert.equal((await first).success, true);
  assert.notEqual(service.announce(), first);
  await service.stop();
  assert.equal(clips, 2);
});

test('missing or unsupported speakers do not prevent other rooms from announcing', async () => {
  for (const failure of ['missing', 'unsupported', 'duplicate']) {
    const { service, calls, players } = fixture({ speakers: { Unavailable: { volume: 10 }, Living: { volume: 25 } } });
    if (failure === 'missing') players.shift();
    if (failure === 'unsupported') players[0].supportsAudioClip = false;
    if (failure === 'duplicate') players.push({ ...players[0] });
    const result = await service.announce();
    assert.equal(result.success, false);
    assert.equal(result.speakers[0].errors[0].stage, 'discovery');
    assert.equal(result.speakers[1].status, 'announced');
    assert.deepEqual(calls, [['discover'], ['clip', 'Living']]);
  }
});

test('discovery failure is reported per eligible room without sending audio', async () => {
  const { service, calls } = fixture({ client: { async discover() { throw new Error('No players found.'); } } });
  const result = await service.announce();
  assert.equal(result.success, false);
  assert.equal(result.speakers[0].errors[0].stage, 'discovery');
  assert.deepEqual(calls, []);
});

test('a failed clip waits for other clips and allows the next request to run', async () => {
  const slowStarted = deferred();
  const finishSlowClip = deferred();
  const { service, client } = fixture({ speakers: { Failed: { volume: 25 }, Slow: { volume: 20 } }, client: {
    async sendAnnouncement(player) {
      if (player.name === 'Failed') throw new Error('Clip failed.');
      slowStarted.resolve();
      await finishSlowClip.promise;
    },
  } });
  const pending = service.announce();
  await slowStarted.promise;
  assert.equal(service.announce(), pending);
  finishSlowClip.resolve();
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.speakers[0].errors[0].stage, 'announcement');
  assert.equal(result.speakers[1].status, 'announced');
  client.sendAnnouncement = async () => {};
  assert.equal((await service.announce()).success, true);
});

test('shutdown rejects new announcements and waits for the current clip', async () => {
  const started = deferred();
  const release = deferred();
  const { service } = fixture({ client: { async sendAnnouncement() { started.resolve(); await release.promise; } } });
  const active = service.announce();
  await started.promise;
  let stopped = false;
  const stop = service.stop().then(() => { stopped = true; });
  await assert.rejects(service.announce(), ShuttingDownError);
  assert.equal(stopped, false);
  release.resolve();
  await active;
  await stop;
  assert.equal(stopped, true);
});

test('an operation with no eligible rooms does not contact Sonos', async () => {
  const { service, calls } = fixture({ speakers: { Quiet: { volume: 10, active: { start: 22, end: 7 } } } });
  assert.equal((await service.announce()).success, true);
  assert.deepEqual(calls, []);
});

test('scheduling uses the configured timezone, including seasonal clock changes', async () => {
  for (const [timestamp, expected] of [
    ['2026-01-19T08:00:00Z', 'announced'], // 09:00 CET
    ['2026-07-19T07:00:00Z', 'announced'], // 09:00 CEST
    ['2026-07-19T06:59:59Z', 'skipped'],
    ['2026-07-19T17:00:00Z', 'skipped'], // 19:00 CEST, end excluded
  ]) {
    const { service } = fixture({ speakers: { Room: { volume: 10, active: { start: 9, end: 19 } } },
      now: () => new Date(timestamp) });
    assert.equal((await service.announce()).speakers[0].status, expected, timestamp);
  }
});
