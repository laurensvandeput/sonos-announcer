import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deferred } from './helpers.mjs';
import { livingId, sonosServer } from './sonos-server.mjs';

const entry = fileURLToPath(new URL('../build/src/index.js', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function configuration(t, url, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sonos-announcer-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'speakers.yaml');
  await writeFile(config, 'speakers:\n  Living:\n    uuid: ' + livingId + '\n    volume: 25\n');
  const clip = join(directory, 'doorbell.mp3');
  await writeFile(clip, 'ID3test audio bytes');
  return { ...process.env, NODE_ENV: 'production', SONOS_HOSTS: new URL(url).host, CLIP_FILE: clip, MEDIA_BASE_URL: 'http://127.0.0.1:3000',
    SPEAKERS_CONFIG: config, PORT: String(await freePort()), NODE_PORT: '',
    ANNOUNCE_TOKEN: '', TIME_ZONE: 'Europe/Brussels', SONOS_REQUEST_TIMEOUT_MS: '1000', SHUTDOWN_TIMEOUT_MS: '4000', ...overrides };
}

function start(t, env) {
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = deferred();
  let output = '';
  let isReady = false;
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output.includes('Listening for announcements.')) { isReady = true; ready.resolve(); }
  });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.on('error', error => { ready.reject(error); reject(error); });
    child.on('exit', (code, signal) => {
      if (!isReady) ready.reject(new Error('Server exited before listening: ' + output));
      resolve({ code, signal });
    });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return { child, ready: ready.promise, exited, output: () => output };
}

test('production entry point fails with a nonzero exit for invalid or missing configuration', async t => {
  const env = await configuration(t, 'http://127.0.0.1:1');
  for (const override of [{ CLIP_FILE: '/nonexistent/doorbell.mp3' }, { SPEAKERS_CONFIG: join(tmpdir(), 'nonexistent-sonos-config.yaml') }]) {
    const child = spawnSync(process.execPath, [entry], { env: { ...env, ...override }, encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 1, child.stdout + child.stderr);
    assert.match(child.stdout, /Startup failed/);
  }
});

test('production starts without SONOS_HOSTS and shuts down cleanly before any discovery', async t => {
  const env = await configuration(t, 'http://127.0.0.1:1', { SONOS_HOSTS: '' });
  const server = start(t, env);
  await server.ready;
  const health = await fetch('http://127.0.0.1:' + env.PORT + '/health');
  assert.equal(health.status, 200);
  await health.text();
  assert.match(server.output(), /automatic SSDP/);
  server.child.kill('SIGTERM');
  assert.deepEqual(await server.exited, { code: 0, signal: null });
});

test('SIGTERM keeps serving the clip while waiting for Sonos completion', async t => {
  const playing = deferred();
  const finishClip = deferred();
  const upstream = await sonosServer(t, { onCommand({ header, body, reply, status }) {
    if (header.command !== 'loadAudioClip') return;
    reply({ id: 'our-clip' });
    playing.resolve(body.streamUrl);
    finishClip.promise.then(() => status('DONE'));
    return true;
  } });
  const env = await configuration(t, upstream.url);
  env.MEDIA_BASE_URL = 'http://127.0.0.1:' + env.PORT;
  const server = start(t, env);
  await server.ready;
  const response = fetch(env.MEDIA_BASE_URL + '/announce');
  const clipUrl = await playing.promise;
  server.child.kill('SIGTERM');
  // Wait for the process to handle SIGTERM before requesting the media.
  for (let attempt = 0; attempt < 100; attempt++) {
    const health = await fetch(env.MEDIA_BASE_URL + '/health');
    await health.text();
    if (health.status === 503) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await fetch(env.MEDIA_BASE_URL + '/announce')).status, 503);
  const media = await fetch(clipUrl);
  assert.equal(media.status, 200);
  assert.equal(await media.text(), 'ID3test audio bytes');
  finishClip.resolve();
  assert.equal((await response).status, 200);
  assert.deepEqual(await server.exited, { code: 0, signal: null });
  assert.match(server.output(), /Shutting down/);
});

test('shutdown enforces its deadline when clip completion is never received', async t => {
  const playing = deferred();
  const upstream = await sonosServer(t, { onCommand({ header, reply }) {
    if (header.command !== 'loadAudioClip') return;
    reply({ id: 'our-clip' }); playing.resolve(); return true;
  } });
  const env = await configuration(t, upstream.url, { SONOS_REQUEST_TIMEOUT_MS: '5000', SHUTDOWN_TIMEOUT_MS: '100' });
  const server = start(t, env);
  await server.ready;
  const response = fetch('http://127.0.0.1:' + env.PORT + '/announce').catch(() => null);
  await playing.promise;
  server.child.kill('SIGTERM');
  assert.deepEqual(await server.exited, { code: 1, signal: null });
  assert.match(server.output(), /Shutdown deadline exceeded/);
  await response;
});

test('read-only speaker CLI works without media configuration and sends no playback commands', async t => {
  const speaker = await sonosServer(t);
  const cli = fileURLToPath(new URL('../build/src/speakers.js', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli], {
    env: { ...process.env, NODE_ENV: 'production', SONOS_HOSTS: new URL(speaker.url).host,
      MEDIA_BASE_URL: '', CLIP_FILE: '/missing.mp3', SONOS_HTTP_SERVER: '' },
    timeout: 5000,
  });
  assert.deepEqual(JSON.parse(stdout), [{ uuid: livingId, name: 'New living room name', audioClip: true, host: '127.0.0.1' }]);
  assert.deepEqual(speaker.calls.map(({ header }) => header.command), [undefined, 'getGroups']);
});
