import { createServer } from 'node:http';
import { AnnounceService } from '../src/Service/Announce.service.ts';
import { SpeakerConfig } from '../src/Config/SpeakerConfig.ts';

export const logger = { info() {}, warn() {}, error() {} };

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function fixture(options = {}) {
  const calls = [];
  const speakers = Object.fromEntries(Object.entries(options.speakers || { Living: { volume: 25 } }).map(([name, value], index) =>
    [name, { uuid: 'RINCON_' + String(index + 1).padStart(12, '0') + '01400', ...value }]));
  const players = Object.entries(speakers).map(([name, value]) => ({
    id: value.uuid, name, householdId: 'test', websocketUrl: 'wss://speaker.test:1443/websocket/api', supportsAudioClip: true,
  }));
  const client = {
    async discover() { calls.push(['discover']); return players; },
    async sendAnnouncement(player) { calls.push(['clip', player.name]); },
    ...options.client,
  };
  const service = new AnnounceService(client, new SpeakerConfig({ speakers }),
    'http://announcer.test/clips/doorbell.mp3', logger, options.timeZone || 'Europe/Brussels',
    options.now || (() => new Date('2026-10-19T10:00:00Z')));
  return { service, client, calls, players, speakers };
}

export async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}

export function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
