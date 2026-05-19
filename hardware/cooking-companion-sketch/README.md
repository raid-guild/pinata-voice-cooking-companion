# Cooking Companion Sketch

Arduino firmware for the RaidGuild Forge AI Recipe Helper: a low-cost countertop cooking companion that keeps recipe interaction off the phone. The prototype uses an ESP32-S3 with a microphone, speaker, two buttons, and an RGB status LED to talk to a Pinata Agent backend.

## What It Does

- Hold the Talk button to record a voice question or recipe request.
- Uploads the recording as a WAV file to the recipe helper API.
- Stores the returned session id so the device can continue the same cooking flow.
- Downloads the temporary TTS MP3 response and plays it through the onboard speaker.
- Press the Next button to ask the backend for the next recipe step.
- Uses the RGB LED for visible state: booting, ready, recording, thinking, speaking, success, and error.

## Hardware

Prototype target: roughly `$28-$48` in parts before enclosure finishing.

Core parts:

- ESP32-S3 development board
- INMP441 I2S MEMS microphone
- MAX98357A I2S amplifier
- Small 4 ohm speaker
- Momentary Talk and Next buttons
- 4-leg common-cathode RGB LED with one resistor per color leg
- USB 5V wall power

Important wiring notes:

- INMP441 must use `3V3`, not `5V`.
- MAX98357A `VIN` uses ESP32 `5V/VBUS`; `SD/EN` can tie to `3V3` if present.
- Speaker connects only to `SPK+` and `SPK-` on the amp.
- Buttons use `INPUT_PULLUP`: one side to GPIO, opposite side to `GND`.
- Avoid GPIO `19` and `20` on ESP32-S3 while using native USB.

## Pin Map

| Function         | ESP32-S3 Pin |
| ---------------- | ------------ |
| Speaker BCLK     | GPIO 4       |
| Speaker LRC / WS | GPIO 5       |
| Speaker DIN      | GPIO 6       |
| RGB LED red      | GPIO 8       |
| RGB LED green    | GPIO 9       |
| RGB LED blue     | GPIO 10      |
| Mic SCK          | GPIO 15      |
| Mic WS           | GPIO 16      |
| Mic SD / DOUT    | GPIO 17      |
| Talk button      | GPIO 18      |
| Next button      | GPIO 21      |

## Firmware Setup

Open `cooking-companion-sketch.ino` in the Arduino IDE or compatible ESP32 build environment, then configure:

```cpp
const char* WIFI_SSID = "WIFI_SSID";
const char* WIFI_PASSWORD = "WIFI_PASSWORD";
const char* API_ORIGIN = "https://example.com";
const char* API_URL_BASE = "https://example.com/app/query-audio";
const char* GATEWAY_TOKEN = "";
```

Use the Pinata voice cooking companion template in this repo as the backend for
`API_ORIGIN` and `API_URL_BASE`.

Leave `DEBUG_VERBOSE_API` set to `false` before sharing serial logs. Verbose API logs can include transcripts, session ids, temporary audio URLs, and response bodies.

Install the ESP32 board support and the audio libraries used by the sketch:

- `AudioFileSourcePROGMEM`
- `AudioGeneratorMP3`
- `AudioOutputI2S`

## Backend Contract

The current sketch expects the local `pinata-voice-cooking-companion` API, or a
compatible protected recipe helper API, with:

- `POST /app/query-audio` multipart upload with `audio=recording.wav` and optional `sessionId`
- `POST /app/query-audio` JSON request for next step with `inputMode: "next_step"` and `sessionId`
- JSON response fields including `session.id`, `transcript`, `intent`, `answerText`, and `audio.url`

Temporary MP3 URLs should be fetched promptly. The firmware downloads MP3 responses into memory, handles chunked transfer framing when needed, and plays the decoded audio through the MAX98357A.
