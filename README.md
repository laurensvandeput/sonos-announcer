# sonos-announcer
A small node.js application to configure your Sonos speakers for visitor announcements. Commands are sent via jishi/node-sonos-http-api.

# Configuration
In order to have this application running, you need to provide a YAML configuration file: `config/speakers.yaml`

```
speakers:
  Sonos Woonkamer:
    volume: 25
  Sonos Eetkamer:
    volume: 30
  Sonos Badkamer:
    volume: 25
    active:
      start: 9
      end: 19
  Sonos Slaapkamer:
    volume: 25
    active:
      start: 9
      end: 20
```
