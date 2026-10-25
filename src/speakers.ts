import dotenv from 'dotenv';
import { readDiscoveryInterface, readSonosUrls } from './Config/AppConfig';
import { SonosClient } from './Sonos/Client';
import { errorDiagnostic, SonosError } from './Sonos/Errors';

// Read-only diagnostics, also usable with `docker exec ... node speakers.js`.
// Does not require a media file or expose a public discovery endpoint.
if ((process.env.NODE_ENV || 'development') === 'development') dotenv.config({ quiet: true });
async function main(): Promise<void> {
  const client = new SonosClient(readSonosUrls(process.env.SONOS_HOSTS), 5000, {
    warn: (message: string, details: unknown) => { process.stderr.write(JSON.stringify({ message, details }) + '\n'); },
  }, { interfaceAddress: readDiscoveryInterface(process.env.SONOS_DISCOVERY_INTERFACE) });
  const players = await client.discover();
  process.stdout.write(JSON.stringify(players.map(player => ({
    uuid: player.id, name: player.name, audioClip: player.supportsAudioClip,
    host: new URL(player.websocketUrl).hostname,
  })), null, 2) + '\n');
}
void main().catch(error => {
  const diagnostic = error instanceof SonosError ? errorDiagnostic(error) : {
    code: 'CONFIGURATION_ERROR', message: error instanceof Error ? error.message : 'Invalid discovery configuration.',
  };
  process.stderr.write(JSON.stringify(diagnostic) + '\n');
  process.exitCode = 1;
});
