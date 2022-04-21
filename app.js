const dotenv = require('dotenv');
const YAML = require('yaml');
const fs = require('fs');
const express = require('express');
const axios = require('axios');

dotenv.config();
const app = express();
const port = 3000;

const sonosServer = process.env.SONOS_HTTP_SERVER;
const clip = process.env.CLIP;

const config = YAML.parse(fs.readFileSync('./config/speakers.yaml', 'utf8'));
let speakers = [];

if (config.speakers && Object.keys(config.speakers).length > 0) {
  speakers = Object.keys(config.speakers);
  console.log(`The following zones are configured: ${speakers.join(', ')}`);
}
else {
  console.log('There are no zones configured.');
}

const stateMap = Object.assign(...speakers.map((k, i) => ({[k]: {volume: 0, uri: null}})));

app.get('/', (req, res) => {
  const currentHour = new Date().getHours();
  const volumePromises = [];
  const announcePromises = [];
  const resetPromises = [];

  speakers.forEach(zone => {
    const speaker = config.speakers[zone];
    const volume = speaker.volume;

    const volumeRequest = axios.get(`${sonosServer}/${zone}/state`)
      .then(response => {
        stateMap[zone].volume = response.data.volume;
        stateMap[zone].uri = response.data.currentTrack.uri;
        stateMap[zone].state = response.data.playbackState;
      });

    volumePromises.push(volumeRequest);

    if (speaker.active && !(currentHour >= speaker.active.start && currentHour < speaker.active.end)) {
      console.log(`Ignoring ${zone}, ${currentHour} is not within ${speaker.active.start}-${speaker.active.end}`);
    } else {
      console.log(`Triggering ${zone} with volume ${volume}`);
      announcePromises.push(axios.get(`${sonosServer}/${zone}/clip/${clip}/${volume}`));
    }
  });

  Promise.all(volumePromises).then(volumeValues => {
    Promise.all(announcePromises).then(announceValues => {
      Object.keys(stateMap).forEach(zone => {
        if (stateMap[zone].state === 'PLAYING') {
          const preset = {
            players: [
              {
                roomName: zone,
                volume: stateMap[zone].volume,
              }
            ],
            uri: stateMap[zone].uri
          };

          const presetJson = JSON.stringify(preset);

          axios.get(`${sonosServer}/${zone}/preset/${presetJson}`).then(response => {
            console.log(`Resetting ${zone}`, preset, response.data);
          })
        }
      })
    })
  });

  res.send();
});

app.listen(port, () => {
  console.log(`\n\nsonos-announcer listening on port ${port}`)
});
