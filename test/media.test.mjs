import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Clip } from '../src/Media/Clip.ts';
import { createApp } from '../src/app.ts';
import { fixture, listen, logger } from './helpers.mjs';

async function file(t, content = 'ID3test audio') {
  const directory = await mkdtemp(join(tmpdir(), 'sonos-clip-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'doorbell.mp3');
  await writeFile(path, content);
  return path;
}

test('serves the exact MP3 with range support without exposing files or discovery', async t => {
  const clip = new Clip(await file(t), 3000, 'http://announcer.test/prefix');
  assert.equal(clip.urlFor('10.1.60.251'), 'http://announcer.test/prefix' + clip.path);
  const { service, calls } = fixture();
  const { url } = await listen(t, createApp(service, logger, 'home-assistant-secret', clip));
  const response = await fetch(url + clip.path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await response.text(), 'ID3test audio');
  const range = await fetch(url + clip.path, { headers: { Range: 'bytes=0-2' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'ID3');
  const head = await fetch(url + clip.path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const path of ['/clips', '/clips/doorbell.mp3', '/clips/unknown.mp3', '/zones', '/config/speakers.yaml']) {
    const missing = await fetch(url + path);
    assert.equal(missing.status, 404);
    await missing.text();
  }
  assert.equal((await fetch(url + '/announce')).status, 401);
  assert.deepEqual(calls, []);
});

test('missing and empty clips fail before listening', async t => {
  const path = await file(t, '');
  assert.throws(() => new Clip(path, 3000), /non-empty/);
  assert.throws(() => new Clip(path + '.missing', 3000));
});

test('media URLs follow the speaker connection address and configured listener port', async t => {
  const clip = new Clip(await file(t), 4000);
  assert.equal(clip.urlFor('10.1.60.251'), 'http://10.1.60.251:4000' + clip.path);
  assert.equal(clip.urlFor('10.1.70.251'), 'http://10.1.70.251:4000' + clip.path);
  assert.equal(clip.urlFor('::ffff:10.1.60.251'), 'http://10.1.60.251:4000' + clip.path);
  assert.equal(clip.urlFor('fd00::1234'), 'http://[fd00::1234]:4000' + clip.path);
});

test('media address resolution rejects unusable addresses and preserves an explicit proxy override', async t => {
  const path = await file(t);
  const clip = new Clip(path, 3000);
  for (const address of [undefined, '', '0.0.0.0', '::', 'speaker.local', '10.1.1.1:3000', 'fe80::1%eth0']) {
    assert.throws(() => clip.urlFor(address), { code: 'MEDIA_ADDRESS_UNAVAILABLE' });
  }
  const overridden = new Clip(path, 3000, 'https://media.example.test/prefix/');
  assert.equal(overridden.urlFor('172.18.0.2'), 'https://media.example.test/prefix' + overridden.path);
  assert.equal(overridden.urlFor(undefined), 'https://media.example.test/prefix' + overridden.path);
});
