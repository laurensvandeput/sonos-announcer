import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import test from 'node:test';
import { searchSonos, ssdpSpeakerUrl } from '../src/Sonos/Ssdp.ts';
import { SonosClient } from '../src/Sonos/Client.ts';
import { livingId, sonosServer } from './sonos-server.mjs';

const urn = 'urn:schemas-upnp-org:device:ZonePlayer:1';
function response(overrides = {}) {
  return Buffer.from('HTTP/1.1 200 OK\r\n' + Object.entries({
    ST: urn, USN: 'uuid:' + livingId + '::' + urn,
    LOCATION: 'http://10.1.60.156:1400/xml/device_description.xml', ...overrides,
  }).map(([name, value]) => name + ': ' + value).join('\r\n') + '\r\n\r\n');
}

async function udpResponder(t, respond) {
  const socket = createSocket('udp4');
  socket.bind(0, '127.0.0.1');
  await once(socket, 'listening');
  t.after(() => new Promise(resolve => socket.close(resolve)));
  socket.on('message', (data, peer) => respond(data, reply => socket.send(reply, peer.port, peer.address)));
  return { addresses: ['127.0.0.1'], destinations: [{ address: '127.0.0.1', port: socket.address().port }] };
}

test('SSDP accepts Sonos identities and rejects unrelated or unsafe advertisements', () => {
  assert.equal(ssdpSpeakerUrl(response()), 'wss://10.1.60.156:1443/websocket/api');
  assert.equal(ssdpSpeakerUrl(Buffer.from(response().toString().replace('LOCATION:', 'location:'))), 'wss://10.1.60.156:1443/websocket/api');
  for (const data of [
    response({ ST: 'ssdp:all' }), response({ USN: 'uuid:not-sonos' }),
    response({ LOCATION: 'http://user:password@10.1.60.156:1400/xml' }),
    response({ LOCATION: 'http://example.com:1400/xml' }), response({ LOCATION: 'file:///etc/passwd' }),
    response({ LOCATION: 'http://10.1.60.156:1400/xml?secret=1' }),
    Buffer.from(response().toString().replace('200 OK', '404 Not Found')),
    Buffer.from(response().toString().replace('\r\n\r\n', '\r\nLOCATION: http://10.1.1.2\r\n\r\n')),
    Buffer.alloc(8193), Buffer.from('garbage'),
  ]) assert.equal(ssdpSpeakerUrl(data), undefined);
});

test('real UDP search sends M-SEARCH, ignores invalid responses and deduplicates players', async t => {
  let requests = 0;
  const network = await udpResponder(t, (data, reply) => {
    requests++;
    assert.match(data.toString(), /^M-SEARCH \* HTTP\/1\.1\r\n/);
    assert.ok(data.toString().includes('MAN: "ssdp:discover"\r\n'));
    assert.ok(data.toString().endsWith('\r\n\r\n'));
    reply(response({ ST: 'upnp:rootdevice' })); reply(response()); reply(response());
  });
  const found = [];
  await searchSonos({ timeoutMs: 150, signal: new AbortController().signal, onAddress: url => found.push(url) }, network);
  assert.equal(requests, 1);
  assert.deepEqual(found, ['wss://10.1.60.156:1443/websocket/api']);
});

test('SSDP retry recovers a lost datagram and cancellation closes the search immediately', async t => {
  let requests = 0;
  const network = await udpResponder(t, (_data, reply) => { if (++requests === 2) reply(response()); });
  const controller = new AbortController();
  const found = [];
  await searchSonos({ timeoutMs: 8000, signal: controller.signal, onAddress: url => {
    found.push(url); controller.abort();
  } }, network);
  assert.equal(requests, 2);
  assert.equal(found.length, 1);
});

test('a failed network interface does not prevent discovery on another interface', async t => {
  const network = await udpResponder(t, (_data, reply) => reply(response()));
  network.addresses.unshift('192.0.2.123');
  const found = [];
  await searchSonos({ timeoutMs: 150, signal: new AbortController().signal, onAddress: url => found.push(url) }, network);
  assert.equal(found.length, 1);
});

test('SSDP handles cancellation before binding, silent networks and unavailable interfaces', async t => {
  const controller = new AbortController();
  controller.abort();
  await searchSonos({ timeoutMs: 5000, signal: controller.signal, onAddress: assert.fail });
  const network = await udpResponder(t, () => {});
  const duringBind = new AbortController();
  const pending = searchSonos({ timeoutMs: 5000, signal: duringBind.signal, onAddress: assert.fail }, network);
  duringBind.abort();
  await pending;
  await searchSonos({ timeoutMs: 30, signal: new AbortController().signal, onAddress: assert.fail }, network);
  await assert.rejects(searchSonos({ timeoutMs: 1000, signal: new AbortController().signal,
    interfaceAddress: '192.0.2.123', onAddress: assert.fail }, network), { code: 'DISCOVERY_FAILED' });
});

function streamingSearch(urls, onAbort = () => {}) {
  return async ({ onAddress, signal }) => {
    await new Promise(resolve => {
      signal.addEventListener('abort', () => { onAbort(); resolve(); }, { once: true });
      for (const url of urls) onAddress(url);
    });
  };
}

test('automatic discovery connects immediately and aborts scanning after the first healthy response', async t => {
  const silent = await sonosServer(t, { onCommand: () => true });
  const healthy = await sonosServer(t);
  let aborted = false;
  const client = new SonosClient([], 1000, undefined, { search: streamingSearch([silent.url, healthy.url], () => { aborted = true; }) });
  const players = await client.discover();
  assert.equal(players[0].websocketUrl, healthy.url);
  assert.equal(aborted, true);
  assert.deepEqual(healthy.calls.map(({ header }) => header.command), [undefined, 'getGroups']);
});

test('automatic discovery reuses known addresses and discovers replacements after an IP change', async t => {
  let oldAddressAvailable = true;
  const old = await sonosServer(t, { onCommand: () => !oldAddressAvailable });
  const replacement = await sonosServer(t);
  let searches = 0;
  const client = new SonosClient([], 1000, undefined, { search: options => {
    searches++;
    return streamingSearch(searches === 1 ? [old.url] : searches === 2 ? [] : [replacement.url])(options);
  } });
  assert.equal((await client.discover())[0].websocketUrl, old.url);
  // With no new SSDP response, a cached address still supplies a fresh topology.
  assert.equal((await client.discover())[0].websocketUrl, old.url);
  oldAddressAvailable = false;
  assert.equal((await client.discover())[0].websocketUrl, replacement.url);
  assert.equal(searches, 3);
});

test('explicit hosts bypass multicast and empty discovery produces an actionable error', async t => {
  const server = await sonosServer(t);
  await new SonosClient([server.url], 1000, undefined, { search: assert.fail }).discover();
  await assert.rejects(new SonosClient([], 1000, undefined, { search: async () => {} }).discover(), error => {
    assert.equal(error.code, 'DISCOVERY_FAILED');
    assert.match(error.message, /Docker networking/);
    assert.deepEqual(error.details.attempts, []);
    return true;
  });
});

test('discovery deadline cancels scanning and late candidates cannot open new connections', async t => {
  const server = await sonosServer(t);
  let onAddress;
  let aborted = false;
  const client = new SonosClient([], 50, undefined, { search: async options => {
    onAddress = options.onAddress;
    await streamingSearch([], () => { aborted = true; })(options);
  } });
  await assert.rejects(client.discover(), { code: 'DISCOVERY_FAILED' });
  assert.equal(aborted, true);
  onAddress(server.url);
  assert.equal(server.calls.length, 0);
});
