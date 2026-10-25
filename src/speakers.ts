import dotenv from 'dotenv';
import { readSonosUrls } from './Config/AppConfig';
import { SonosClient } from './Sonos/Client';

// Read-only diagnostics, also usable with `docker exec ... node speakers.js`.
// Does not require a media file or expose a public discovery endpoint.
if ((process.env.NODE_ENV || 'development') === 'development') dotenv.config({ quiet: true });
async function main(): Promise<void> {
  const client = new SonosClient(readSonosUrls(process.env.SONOS_HOSTS), 5000);
  const players = await client.discover();
  process.stdout.write(JSON.stringify(players.map(player => ({
    uuid: player.id, name: player.name, audioClip: player.supportsAudioClip,
    host: new URL(player.websocketUrl).hostname,
  })), null, 2) + '\n');
}
void main().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : 'Sonos discovery failed.') + '\n');
  process.exitCode = 1;
});
