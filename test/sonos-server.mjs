import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';

export const livingId = 'RINCON_347E5C8246BA01400';
export const kitchenId = 'RINCON_804AF28596D001400';

// Test-only self-signed certificate. No real Sonos devices or audio are used.
export async function sonosServer(t, options = {}) {
  const server = createServer({
    key: readFileSync(new URL('./fixtures/sonos-key.pem', import.meta.url)),
    cert: readFileSync(new URL('./fixtures/sonos-cert.pem', import.meta.url)),
  });
  const sockets = new WebSocketServer({ server, path: '/websocket/api',
    verifyClient: options.rejectHandshake ? (_info, done) => done(false, 400, 'Bad Request') : undefined,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'wss://127.0.0.1:' + server.address().port + '/websocket/api';
  const player = { id: livingId, name: 'New living room name', websocketUrl: url,
    devices: [{ id: livingId, capabilities: ['PLAYBACK', 'AUDIO_CLIP'] }] };
  const calls = [];
  sockets.on('connection', (socket, req) => {
    assert.equal(req.headers['sec-websocket-protocol'], 'v1.api.smartspeaker.audio');
    assert.equal(req.headers['x-sonos-api-key'], '123e4567-e89b-12d3-a456-426655440000');
    socket.on('message', raw => {
      const [header, body] = JSON.parse(raw);
      calls.push({ header, body });
      const reply = (payload = {}, extra = {}) => socket.send(JSON.stringify([
        { namespace: header.namespace, householdId: 'test-household', playerId: header.playerId,
          response: header.command, success: true, type: 'none', cmdId: header.cmdId, ...extra }, payload,
      ]));
      const status = (state, id = 'our-clip', playerId = livingId) => socket.send(JSON.stringify([
        { namespace: 'audioClip:1', name: 'audioClipStatus', type: 'audioClipStatus', playerId },
        { audioClips: [{ id, status: state }] },
      ]));
      if (options.onCommand?.({ header, body, reply, status, socket, player }) === true) return;
      switch (header.command) {
        case undefined:
          reply({}, { namespace: 'global', response: '', success: false, type: 'globalError', cmdId: undefined });
          break;
        case 'getGroups': reply({ players: [player] }, { type: 'groups' }); break;
        case 'subscribe': reply(); break;
        case 'loadAudioClip': reply({ id: 'our-clip' }, { type: 'audioClip' }); status('DONE'); break;
        default: reply({}, { success: false, type: 'globalError' });
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  return { url, player, calls, sockets };
}
