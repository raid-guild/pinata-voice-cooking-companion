#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "driver/i2s_std.h"

#include <AudioFileSourcePROGMEM.h>
#include <AudioGeneratorMP3.h>
#include <AudioOutputI2S.h>

// =====================
// Wi-Fi / API config
// =====================

const char* WIFI_SSID = "WIFI_SSID";
const char* WIFI_PASSWORD = "WIFI_PASSWORD";

const char* API_ORIGIN = "https://example.com";
const char* API_URL_BASE = "https://example.com/app/query-audio";

// Pinata private gateway access token.
// If your agent is public during local testing, leave this as "".
// If your agent requires `?token=...`, paste the token here.
const char* GATEWAY_TOKEN = "";

// Keep false before sharing logs publicly. Verbose mode can include transcripts,
// session ids, temporary audio URLs, and API response bodies.
const bool DEBUG_VERBOSE_API = false;

// Keep false during normal countertop use. Enable while tuning latency/audio.
const bool DEBUG_TIMING = false;

// Stored after successful API responses.
String sessionId = "";

// =====================
// Buttons
// =====================
//
// Talk button:
// One side -> ESP32 GPIO 18
// Opposite side -> ESP32 GND
//
// Next button:
// One side -> ESP32 GPIO 21
// Opposite side -> ESP32 GND
//
// Both use internal pull-ups:
// not pressed = HIGH
// pressed     = LOW
//
// Avoid GPIO 19/20 on ESP32-S3 while using native USB.

#define TALK_BUTTON_PIN 18
#define NEXT_BUTTON_PIN 21

// =====================
// RGB LED / status light
// =====================
//
// Common-cathode RGB LED:
// Common/longest leg -> GND
// Red   -> resistor -> GPIO 8
// Green -> resistor -> GPIO 9
// Blue  -> resistor -> GPIO 10

#define LED_R_PIN 8
#define LED_G_PIN 9
#define LED_B_PIN 10

const int STATUS_OFF = 0;
const int STATUS_BOOTING = 1;
const int STATUS_SETUP = 2;
const int STATUS_READY = 3;
const int STATUS_RECORDING = 4;
const int STATUS_THINKING = 5;
const int STATUS_PLAYING = 6;
const int STATUS_SUCCESS = 7;
const int STATUS_ERROR = 8;

int currentStatus = STATUS_OFF;

// =====================
// Speaker / MAX98357A
// =====================
//
// ESP32 GPIO 4  -> MAX98357A BCLK
// ESP32 GPIO 5  -> MAX98357A LRC / WS
// ESP32 GPIO 6  -> MAX98357A DIN
//
// ESP32 5V/VBUS -> MAX98357A VIN
// ESP32 GND     -> MAX98357A GND
// ESP32 3V3     -> MAX98357A SD / EN, if your amp board has that pin
//
// MAX98357A SPK+ -> Speaker +
// MAX98357A SPK- -> Speaker -

#define SPK_BCLK_PIN 4
#define SPK_LRC_PIN  5
#define SPK_DIN_PIN  6

// Playback gain for the MAX98357A speaker path.
// Try 0.90 or 1.00 if the enclosure is still too quiet and the audio stays clean.
const float SPEAKER_PLAYBACK_GAIN = 0.75f;

void parkSpeakerPins() {
  // Keep the MAX98357A inputs quiet until the I2S playback driver owns them.
  pinMode(SPK_BCLK_PIN, OUTPUT);
  pinMode(SPK_LRC_PIN, OUTPUT);
  pinMode(SPK_DIN_PIN, OUTPUT);

  digitalWrite(SPK_BCLK_PIN, LOW);
  digitalWrite(SPK_LRC_PIN, LOW);
  digitalWrite(SPK_DIN_PIN, LOW);
}

// =====================
// Microphone / INMP441
// =====================
//
// INMP441 SCK       -> ESP32 GPIO 15
// INMP441 WS        -> ESP32 GPIO 16
// INMP441 SD / DOUT -> ESP32 GPIO 17
//
// INMP441 VDD / 3V3 -> ESP32 3V3
// INMP441 GND       -> ESP32 GND
// INMP441 L/R       -> GND

#define MIC_BCLK_PIN 15
#define MIC_WS_PIN   16
#define MIC_DOUT_PIN 17

// =====================
// Audio recording settings
// =====================
//
// Important:
// Mic I2S captures at 16 kHz, but earlier playback tests suggested the captured
// audio behaves like it should be interpreted faster. So the WAV header is set
// to 32 kHz for upload. This may make the backend transcriber hear normal speed.

const int MIC_I2S_SAMPLE_RATE = 16000;
const int WAV_HEADER_SAMPLE_RATE = 32000;

const int BITS_PER_SAMPLE = 16;
const int CHANNELS = 1;

const int MAX_RECORD_SECONDS = 5;
const int MAX_SAMPLE_COUNT = MIC_I2S_SAMPLE_RATE * MAX_RECORD_SECONDS;

// 10 sec * 16,000 samples/sec * 2 bytes/sample = 320 KB
int16_t* pcmBuffer = nullptr;
int samplesRecorded = 0;

// WAV buffer = 44-byte header + PCM data.
uint8_t* wavBuffer = nullptr;
size_t wavSize = 0;

static i2s_chan_handle_t mic_rx_chan;

// =====================
// Cleaner STT-oriented processing
// =====================
//
// Goal: make transcription better, not local playback louder.
// Avoid heavy noise gate / soft limiter / aggressive RMS normalization.
// A slightly quiet, clean recording is usually better for STT than crunchy audio.

const int MIC_SHIFT = 15;

// Gentle gain after DC offset removal.
// If transcription is still weak/quiet, try 1.5f.
// If it sounds clipped/crunchy, try 0.8f.
const float UPLOAD_PCM_GAIN = 1.2f;

// Safety ceiling to avoid hard clipping.
// This is not a “make it loud” limiter; it just prevents overflow.
const int UPLOAD_CLIP_CEILING = 30000;

// =====================
// MP3 download/playback
// =====================

const size_t MAX_MP3_BYTES = 1024 * 1024; // 1 MB

uint8_t* mp3Bytes = nullptr;
size_t mp3Size = 0;

// =====================
// Button helpers
// =====================

bool talkButtonPressed() {
  return digitalRead(TALK_BUTTON_PIN) == LOW;
}

bool nextButtonPressed() {
  return digitalRead(NEXT_BUTTON_PIN) == LOW;
}

// =====================
// Utility helpers
// =====================

bool bufferEndsWithFinalChunk(const uint8_t* data, size_t len) {
  if (len < 5) return false;

  // Common terminal chunk ending: "0\r\n\r\n"
  return data[len - 5] == '0' &&
         data[len - 4] == '\r' &&
         data[len - 3] == '\n' &&
         data[len - 2] == '\r' &&
         data[len - 1] == '\n';
}

int16_t clampInt16(int32_t value) {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return (int16_t)value;
}

int16_t clampForUpload(int32_t sample) {
  if (sample > UPLOAD_CLIP_CEILING) sample = UPLOAD_CLIP_CEILING;
  if (sample < -UPLOAD_CLIP_CEILING) sample = -UPLOAD_CLIP_CEILING;
  return clampInt16(sample);
}

void writeLe16(uint8_t* buffer, int offset, uint16_t value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
}

void writeLe32(uint8_t* buffer, int offset, uint32_t value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
  buffer[offset + 3] = (value >> 24) & 0xff;
}

String extractJsonStringAfter(const String& response, const String& marker) {
  int start = response.indexOf(marker);
  if (start < 0) return "";

  start += marker.length();

  int end = response.indexOf("\"", start);
  if (end < 0) return "";

  return response.substring(start, end);
}

String withGatewayToken(const String& url) {
  String token = String(GATEWAY_TOKEN);

  if (token.length() == 0 || token == "GATEWAY_TOKEN") {
    return url;
  }

  String separator = url.indexOf("?") >= 0 ? "&" : "?";
  return url + separator + "token=" + token;
}

String redactSensitiveUrl(const String& url) {
  String redacted = url;
  int tokenStart = redacted.indexOf("token=");

  if (tokenStart < 0) {
    return redacted;
  }

  int valueStart = tokenStart + 6;
  int valueEnd = redacted.indexOf("&", valueStart);

  if (valueEnd < 0) {
    return redacted.substring(0, valueStart) + "[redacted]";
  }

  return redacted.substring(0, valueStart) + "[redacted]" + redacted.substring(valueEnd);
}

String makeAbsoluteAudioUrl(const String& audioUrl) {
  if (audioUrl.length() == 0) return "";

  String fullUrl;

  if (audioUrl.startsWith("http://") || audioUrl.startsWith("https://")) {
    fullUrl = audioUrl;
  } else if (audioUrl.startsWith("/")) {
    fullUrl = String(API_ORIGIN) + audioUrl;
  } else {
    fullUrl = String(API_ORIGIN) + "/" + audioUrl;
  }

  return withGatewayToken(fullUrl);
}


// =====================
// RGB LED status helpers
// =====================

void setRgbRaw(int red, int green, int blue) {
  analogWrite(LED_R_PIN, red);
  analogWrite(LED_G_PIN, green);
  analogWrite(LED_B_PIN, blue);
}

void setRgbOff() {
  setRgbRaw(0, 0, 0);
}

void setSolidWhite() {
  setRgbRaw(255, 255, 255);
}

void setSolidBlue() {
  setRgbRaw(0, 0, 255);
}

void setSolidGreen() {
  setRgbRaw(0, 255, 0);
}

void setSolidYellow() {
  setRgbRaw(255, 160, 0);
}

void setSolidRed() {
  setRgbRaw(255, 0, 0);
}

void setSolidPurple() {
  setRgbRaw(180, 0, 255);
}

void setStatus(int status) {
  currentStatus = status;

  switch (status) {
    case STATUS_OFF:
      setRgbOff();
      break;
    case STATUS_BOOTING:
      setSolidWhite();
      break;
    case STATUS_SETUP:
      setSolidPurple();
      break;
    case STATUS_READY:
      setSolidBlue();
      break;
    case STATUS_SUCCESS:
      setSolidGreen();
      break;
    case STATUS_ERROR:
      setSolidRed();
      break;
    case STATUS_RECORDING:
    case STATUS_THINKING:
      setSolidYellow();
      break;
    case STATUS_PLAYING:
      setSolidBlue();
      break;
    default:
      // Animated states are handled by updateStatusLed().
      break;
  }
}

int pulseValue(unsigned long nowMs, int periodMs) {
  float phase = (nowMs % periodMs) / (float)periodMs;
  float wave = (sin(phase * 2.0f * PI) + 1.0f) / 2.0f;
  return (int)(30 + wave * 225);
}

void updateStatusLed() {
  unsigned long now = millis();

  switch (currentStatus) {
    case STATUS_BOOTING:
      setSolidWhite();
      break;

    case STATUS_SETUP:
      setSolidPurple();
      break;

    case STATUS_READY:
      setSolidBlue();
      break;

    case STATUS_RECORDING: {
      int v = pulseValue(now, 900);
      setRgbRaw(v, (int)(v * 0.55f), 0); // yellow pulse
      break;
    }

    case STATUS_THINKING: {
      int v = pulseValue(now, 1200);
      setRgbRaw(v, (int)(v * 0.55f), 0); // yellow pulse
      break;
    }

    case STATUS_PLAYING: {
      int v = pulseValue(now, 1000);
      setRgbRaw(0, 0, v); // blue pulse
      break;
    }

    case STATUS_SUCCESS:
      setSolidGreen();
      break;

    case STATUS_ERROR: {
      bool on = ((now / 200) % 2) == 0;
      if (on) setSolidRed();
      else setRgbOff();
      break;
    }

    case STATUS_OFF:
    default:
      setRgbOff();
      break;
  }
}

void flashSuccessThenReady() {
  setStatus(STATUS_SUCCESS);
  unsigned long startMs = millis();
  while (millis() - startMs < 700) {
    updateStatusLed();
    delay(10);
  }
  setStatus(STATUS_READY);
}

void markError() {
  setStatus(STATUS_ERROR);
}

// =====================
// Wi-Fi
// =====================

void connectWiFi() {
  setStatus(STATUS_THINKING);

  Serial.println();
  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;

  while (WiFi.status() != WL_CONNECTED && attempts < 60) {
    updateStatusLed();
    delay(500);
    Serial.print(".");
    attempts++;
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Wi-Fi connected.");
    Serial.print("IP address: ");
    Serial.println(WiFi.localIP());
    Serial.print("RSSI: ");
    Serial.println(WiFi.RSSI());
    setStatus(STATUS_READY);
  } else {
    Serial.println("Wi-Fi connection failed.");
    markError();
  }
}

// =====================
// Mic I2S setup
// =====================

void setupMicI2S() {
  // Use I2S_NUM_1 for mic so the MP3 playback library can use its own I2S output.
  i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(
    I2S_NUM_1,
    I2S_ROLE_MASTER
  );

  esp_err_t err = i2s_new_channel(&chan_cfg, NULL, &mic_rx_chan);
  if (err != ESP_OK) {
    Serial.printf("Mic i2s_new_channel failed: %d\n", err);
    return;
  }

  i2s_std_config_t std_cfg = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(MIC_I2S_SAMPLE_RATE),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
      I2S_DATA_BIT_WIDTH_32BIT,
      I2S_SLOT_MODE_MONO
    ),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = (gpio_num_t)MIC_BCLK_PIN,
      .ws = (gpio_num_t)MIC_WS_PIN,
      .dout = I2S_GPIO_UNUSED,
      .din = (gpio_num_t)MIC_DOUT_PIN,
      .invert_flags = {
        .mclk_inv = false,
        .bclk_inv = false,
        .ws_inv = false,
      },
    },
  };

  err = i2s_channel_init_std_mode(mic_rx_chan, &std_cfg);
  if (err != ESP_OK) {
    Serial.printf("Mic i2s_channel_init_std_mode failed: %d\n", err);
    return;
  }

  err = i2s_channel_enable(mic_rx_chan);
  if (err != ESP_OK) {
    Serial.printf("Mic i2s_channel_enable failed: %d\n", err);
    return;
  }

  Serial.println("Mic I2S initialized.");
}

// =====================
// Buffers
// =====================

bool allocateBuffers() {
  size_t pcmBytes = MAX_SAMPLE_COUNT * sizeof(int16_t);
  size_t maxWavBytes = 44 + pcmBytes;

  Serial.print("Allocating PCM buffer bytes: ");
  Serial.println(pcmBytes);

  pcmBuffer = (int16_t*)ps_malloc(pcmBytes);
  if (pcmBuffer == nullptr) {
    Serial.println("PSRAM PCM allocation failed; trying regular heap...");
    pcmBuffer = (int16_t*)malloc(pcmBytes);
  }

  if (pcmBuffer == nullptr) {
    Serial.println("ERROR: Could not allocate PCM buffer.");
    return false;
  }

  Serial.print("Allocating WAV buffer bytes: ");
  Serial.println(maxWavBytes);

  wavBuffer = (uint8_t*)ps_malloc(maxWavBytes);
  if (wavBuffer == nullptr) {
    Serial.println("PSRAM WAV allocation failed; trying regular heap...");
    wavBuffer = (uint8_t*)malloc(maxWavBytes);
  }

  if (wavBuffer == nullptr) {
    Serial.println("ERROR: Could not allocate WAV buffer.");
    return false;
  }

  Serial.println("Buffers allocated.");
  return true;
}

void clearRecordingBuffers() {
  if (pcmBuffer) {
    memset(pcmBuffer, 0, MAX_SAMPLE_COUNT * sizeof(int16_t));
  }

  if (wavBuffer) {
    memset(wavBuffer, 0, 44 + MAX_SAMPLE_COUNT * sizeof(int16_t));
  }

  samplesRecorded = 0;
  wavSize = 0;
}

void freeMp3Buffer() {
  if (mp3Bytes != nullptr) {
    free(mp3Bytes);
    mp3Bytes = nullptr;
  }

  mp3Size = 0;
}

// =====================
// Cleaner PCM processing + WAV
// =====================

void processPcmForUpload() {
  if (!pcmBuffer || samplesRecorded <= 0) return;

  Serial.println("Processing PCM for upload...");

  // Pass 1: DC offset.
  int64_t sum = 0;

  for (int i = 0; i < samplesRecorded; i++) {
    sum += pcmBuffer[i];
  }

  int32_t dcOffset = sum / samplesRecorded;

  Serial.print("DC offset: ");
  Serial.println(dcOffset);

  // Pass 2: stats before processing.
  uint64_t squareSum = 0;
  int32_t peak = 0;

  for (int i = 0; i < samplesRecorded; i++) {
    int32_t centered = (int32_t)pcmBuffer[i] - dcOffset;
    int32_t absVal = abs(centered);

    if (absVal > peak) peak = absVal;

    squareSum += (int64_t)centered * (int64_t)centered;
  }

  float rms = sqrt((float)squareSum / (float)samplesRecorded);

  Serial.print("Peak before upload process: ");
  Serial.println(peak);

  Serial.print("RMS before upload process: ");
  Serial.println(rms);

  // Pass 3: only DC removal + gentle gain.
  int32_t newPeak = 0;
  uint64_t newSquareSum = 0;

  for (int i = 0; i < samplesRecorded; i++) {
    int32_t centered = (int32_t)pcmBuffer[i] - dcOffset;
    int32_t boosted = (int32_t)(centered * UPLOAD_PCM_GAIN);

    int16_t out = clampForUpload(boosted);
    pcmBuffer[i] = out;

    int32_t absVal = abs((int)out);
    if (absVal > newPeak) newPeak = absVal;

    newSquareSum += (int64_t)out * (int64_t)out;
  }

  float newRms = sqrt((float)newSquareSum / (float)samplesRecorded);

  Serial.print("Peak after upload process: ");
  Serial.println(newPeak);

  Serial.print("RMS after upload process: ");
  Serial.println(newRms);
}

void buildWavFromPcm() {
  if (!pcmBuffer || !wavBuffer || samplesRecorded <= 0) {
    Serial.println("Cannot build WAV: missing samples or buffers.");
    return;
  }

  const uint32_t dataBytes = samplesRecorded * sizeof(int16_t);
  const uint32_t fileSizeMinus8 = 36 + dataBytes;

  // IMPORTANT: Use WAV_HEADER_SAMPLE_RATE, not MIC_I2S_SAMPLE_RATE.
  const uint32_t byteRate = WAV_HEADER_SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  const uint16_t blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);

  memcpy(wavBuffer + 0, "RIFF", 4);
  writeLe32(wavBuffer, 4, fileSizeMinus8);
  memcpy(wavBuffer + 8, "WAVE", 4);

  memcpy(wavBuffer + 12, "fmt ", 4);
  writeLe32(wavBuffer, 16, 16);
  writeLe16(wavBuffer, 20, 1);
  writeLe16(wavBuffer, 22, CHANNELS);
  writeLe32(wavBuffer, 24, WAV_HEADER_SAMPLE_RATE);
  writeLe32(wavBuffer, 28, byteRate);
  writeLe16(wavBuffer, 32, blockAlign);
  writeLe16(wavBuffer, 34, BITS_PER_SAMPLE);

  memcpy(wavBuffer + 36, "data", 4);
  writeLe32(wavBuffer, 40, dataBytes);

  memcpy(wavBuffer + 44, pcmBuffer, dataBytes);

  wavSize = 44 + dataBytes;

  Serial.println("WAV created.");
  Serial.print("Mic I2S sample rate: ");
  Serial.println(MIC_I2S_SAMPLE_RATE);

  Serial.print("WAV header sample rate: ");
  Serial.println(WAV_HEADER_SAMPLE_RATE);

  Serial.print("WAV total bytes: ");
  Serial.println(wavSize);

  Serial.print("WAV duration ms according to header: ");
  Serial.println((samplesRecorded * 1000) / WAV_HEADER_SAMPLE_RATE);

  Serial.print("Raw captured sample count: ");
  Serial.println(samplesRecorded);
}

// =====================
// Talk recording
// =====================

void waitForTalkButtonRelease() {
  while (talkButtonPressed()) {
    updateStatusLed();
    delay(10);
  }

  delay(50);
  Serial.println("Talk button released.");
}

void waitForNextButtonRelease() {
  while (nextButtonPressed()) {
    updateStatusLed();
    delay(10);
  }

  delay(50);
  Serial.println("Next button released.");
}

void recordWhileTalkHeld() {
  setStatus(STATUS_RECORDING);
  clearRecordingBuffers();

  Serial.println("RECORDING while Talk button is held...");
  Serial.println("Release Talk button to stop.");

  const int READ_CHUNK = 256;
  int32_t micSamples[READ_CHUNK];

  int64_t totalAbs = 0;
  int16_t minSample = 32767;
  int16_t maxSample = -32768;

  unsigned long startMs = millis();

  while (talkButtonPressed() && samplesRecorded < MAX_SAMPLE_COUNT) {
    updateStatusLed();
    size_t bytesRead = 0;

    esp_err_t err = i2s_channel_read(
      mic_rx_chan,
      micSamples,
      sizeof(micSamples),
      &bytesRead,
      portMAX_DELAY
    );

    if (err != ESP_OK) {
      Serial.printf("Mic read failed: %d\n", err);
      return;
    }

    int samplesRead = bytesRead / sizeof(int32_t);

    for (int i = 0; i < samplesRead && samplesRecorded < MAX_SAMPLE_COUNT; i++) {
      int32_t sample32 = micSamples[i] >> MIC_SHIFT;
      int16_t sample16 = clampInt16(sample32);

      pcmBuffer[samplesRecorded] = sample16;

      totalAbs += abs((int)sample16);
      if (sample16 < minSample) minSample = sample16;
      if (sample16 > maxSample) maxSample = sample16;

      samplesRecorded++;
    }
  }

  unsigned long elapsedMs = millis() - startMs;

  Serial.println("Recording stopped.");
  Serial.print("Recording elapsed ms: ");
  Serial.println(elapsedMs);

  Serial.print("Samples recorded: ");
  Serial.println(samplesRecorded);

  if (samplesRecorded > 0) {
    int avgLevel = totalAbs / samplesRecorded;

    if (DEBUG_TIMING) {
      Serial.print("Avg level before upload process: ");
      Serial.println(avgLevel);

      Serial.print("Min sample before upload process: ");
      Serial.println(minSample);

      Serial.print("Max sample before upload process: ");
      Serial.println(maxSample);
    }

    unsigned long processStartMs = millis();

    processPcmForUpload();

    unsigned long processEndMs = millis();

    buildWavFromPcm();

    unsigned long wavEndMs = millis();

    if (DEBUG_TIMING) {
      Serial.print("TIMING process PCM ms: ");
      Serial.println(processEndMs - processStartMs);

      Serial.print("TIMING build WAV ms: ");
      Serial.println(wavEndMs - processEndMs);

      Serial.print("TIMING record+process+wav total ms: ");
      Serial.println(wavEndMs - startMs);
    }
  } else {
    Serial.println("No samples recorded.");
  }

  if (samplesRecorded >= MAX_SAMPLE_COUNT) {
    Serial.println("Max recording length reached.");
    waitForTalkButtonRelease();
  }
}

// =====================
// JSON response handling
// =====================

void updateSessionFromResponse(const String& response) {
  String extracted = extractJsonStringAfter(response, "\"session\":{\"id\":\"");

  if (extracted.length() > 0) {
    sessionId = extracted;
    if (DEBUG_VERBOSE_API) {
      Serial.print("Stored sessionId: ");
      Serial.println(sessionId);
    } else {
      Serial.println("Stored sessionId.");
    }
  } else {
    Serial.println("No session.id found in response.");
  }
}

String extractAudioUrlFromResponse(const String& response) {
  return extractJsonStringAfter(response, "\"url\":\"");
}

void printUsefulResponseFields(const String& response) {
  String transcript = extractJsonStringAfter(response, "\"transcript\":\"");
  String intent = extractJsonStringAfter(response, "\"intent\":\"");
  String answerText = extractJsonStringAfter(response, "\"answerText\":\"");
  String audioUrl = extractAudioUrlFromResponse(response);

  if (DEBUG_VERBOSE_API && transcript.length() > 0) {
    Serial.print("transcript: ");
    Serial.println(transcript);
  }

  if (intent.length() > 0) {
    Serial.print("intent: ");
    Serial.println(intent);
  }

  if (DEBUG_VERBOSE_API && answerText.length() > 0) {
    Serial.print("answerText: ");
    Serial.println(answerText);
  }

  if (DEBUG_VERBOSE_API && audioUrl.length() > 0) {
    Serial.print("audio.url: ");
    Serial.println(audioUrl);
  }
}

// =====================
// Chunked MP3 helpers
// =====================

int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
  if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
  return -1;
}

bool looksLikeChunkedBody(const uint8_t* data, size_t len) {
  if (len < 4) return false;

  for (size_t i = 0; i < min((size_t)12, len - 1); i++) {
    if (data[i] == '\r' && data[i + 1] == '\n') {
      return i > 0;
    }

    char c = (char)data[i];
    bool isHex =
      (c >= '0' && c <= '9') ||
      (c >= 'a' && c <= 'f') ||
      (c >= 'A' && c <= 'F');

    if (!isHex) return false;
  }

  return false;
}

bool dechunkHttpBodyInPlace(uint8_t* buffer, size_t inputSize, size_t* outputSize) {
  size_t readPos = 0;
  size_t writePos = 0;

  while (readPos < inputSize) {
    size_t chunkSize = 0;
    bool sawHex = false;

    while (readPos < inputSize) {
      char c = (char)buffer[readPos];

      if (c == '\r') {
        if (readPos + 1 < inputSize && buffer[readPos + 1] == '\n') {
          readPos += 2;
          break;
        } else {
          Serial.println("Malformed chunk header: CR without LF.");
          return false;
        }
      }

      if (c == ';') {
        while (readPos < inputSize) {
          if (buffer[readPos] == '\r' && readPos + 1 < inputSize && buffer[readPos + 1] == '\n') {
            readPos += 2;
            break;
          }
          readPos++;
        }
        break;
      }

      int hv = hexValue(c);
      if (hv < 0) {
        Serial.println("Malformed chunk header: non-hex character.");
        return false;
      }

      sawHex = true;
      chunkSize = (chunkSize * 16) + hv;
      readPos++;
    }

    if (!sawHex) {
      Serial.println("Malformed chunk header: no hex size.");
      return false;
    }

    if (chunkSize == 0) {
      *outputSize = writePos;
      return true;
    }

    if (readPos + chunkSize > inputSize) {
      Serial.println("Malformed chunk body: chunk extends past buffer.");
      return false;
    }

    memmove(buffer + writePos, buffer + readPos, chunkSize);
    writePos += chunkSize;
    readPos += chunkSize;

    if (readPos + 1 < inputSize && buffer[readPos] == '\r' && buffer[readPos + 1] == '\n') {
      readPos += 2;
    } else {
      Serial.println("Malformed chunk body: missing trailing CRLF.");
      return false;
    }
  }

  *outputSize = writePos;
  return true;
}

bool looksLikeMp3(const uint8_t* data, size_t len) {
  if (len < 3) return false;

  if (data[0] == 'I' && data[1] == 'D' && data[2] == '3') {
    return true;
  }

  if (len >= 2 && data[0] == 0xFF && (data[1] & 0xE0) == 0xE0) {
    return true;
  }

  return false;
}

void printFirstBytes(const uint8_t* data, size_t len) {
  if (!DEBUG_TIMING) return;

  Serial.println("First 32 bytes:");

  size_t n = min((size_t)32, len);

  for (size_t i = 0; i < n; i++) {
    if (data[i] < 16) Serial.print("0");
    Serial.print(data[i], HEX);
    Serial.print(" ");
  }

  Serial.println();
}

// =====================
// MP3 download + playback
// =====================

bool downloadMp3ToMemory(const String& fullUrl) {
  setStatus(STATUS_THINKING);
  freeMp3Buffer();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Cannot download MP3: Wi-Fi not connected.");
    return false;
  }

  Serial.println();
  Serial.println("Downloading MP3 to memory...");
  Serial.print("URL: ");
  Serial.println(redactSensitiveUrl(fullUrl));

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(30000);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  if (!http.begin(client, fullUrl)) {
    Serial.println("HTTP begin failed.");
    return false;
  }

  int statusCode = http.GET();

  Serial.print("HTTP status: ");
  Serial.println(statusCode);

  int contentLength = http.getSize();
  Serial.print("Content-Length/getSize: ");
  Serial.println(contentLength);

  if (statusCode != 200) {
    Serial.println("MP3 download failed: non-200 status.");
    String response = http.getString();
    if (DEBUG_VERBOSE_API) {
      Serial.println("Response body:");
      Serial.println(response);
    }
    http.end();
    return false;
  }

  mp3Bytes = (uint8_t*)ps_malloc(MAX_MP3_BYTES);
  if (mp3Bytes == nullptr) {
    Serial.println("PSRAM MP3 allocation failed; trying regular heap...");
    mp3Bytes = (uint8_t*)malloc(MAX_MP3_BYTES);
  }

  if (mp3Bytes == nullptr) {
    Serial.println("MP3 download failed: could not allocate buffer.");
    http.end();
    return false;
  }

  WiFiClient* stream = http.getStreamPtr();

  size_t totalRead = 0;
  unsigned long lastDataMs = millis();

  while (http.connected()) {
    updateStatusLed();
    int available = stream->available();

    if (available > 0) {
      size_t remainingCapacity = MAX_MP3_BYTES - totalRead;

      if (remainingCapacity == 0) {
        Serial.println("MP3 exceeded MAX_MP3_BYTES.");
        freeMp3Buffer();
        http.end();
        return false;
      }

      int toRead = min((size_t)available, remainingCapacity);
      int bytesRead = stream->readBytes(mp3Bytes + totalRead, toRead);

      if (bytesRead > 0) {
        totalRead += bytesRead;
        lastDataMs = millis();

        if (bufferEndsWithFinalChunk(mp3Bytes, totalRead)) {
          Serial.println("Detected final chunk marker.");
          break;
        }
      }
    } else {
      delay(1);

      if (contentLength > 0 && totalRead >= (size_t)contentLength) {
        break;
      }

      if (millis() - lastDataMs > 400) {
        break;
      }
    }
  }

  mp3Size = totalRead;

  if (DEBUG_TIMING) {
    Serial.print("Downloaded MP3 bytes: ");
    Serial.println(mp3Size);
  }

  if (mp3Size == 0) {
    Serial.println("MP3 download failed: zero bytes.");
    freeMp3Buffer();
    http.end();
    return false;
  }

  printFirstBytes(mp3Bytes, mp3Size);

  if (looksLikeChunkedBody(mp3Bytes, mp3Size)) {
    Serial.println("Detected chunked HTTP body. Dechunking...");

    size_t dechunkedSize = 0;

    if (!dechunkHttpBodyInPlace(mp3Bytes, mp3Size, &dechunkedSize)) {
      Serial.println("Failed to dechunk HTTP body.");
      freeMp3Buffer();
      http.end();
      return false;
    }

    mp3Size = dechunkedSize;

    if (DEBUG_TIMING) {
      Serial.print("Dechunked MP3 bytes: ");
      Serial.println(mp3Size);
    }

    printFirstBytes(mp3Bytes, mp3Size);
  }

  if (!looksLikeMp3(mp3Bytes, mp3Size)) {
    Serial.println("Downloaded data does not look like MP3.");
    freeMp3Buffer();
    http.end();
    return false;
  }

  Serial.println("Downloaded data looks like MP3.");

  http.end();
  return true;
}

void playMp3FromMemory() {
  setStatus(STATUS_PLAYING);

  if (mp3Bytes == nullptr || mp3Size == 0) {
    Serial.println("No MP3 bytes loaded.");
    return;
  }

  Serial.println();
  Serial.println("Playing MP3 from memory...");

  AudioFileSourcePROGMEM* file = new AudioFileSourcePROGMEM(mp3Bytes, mp3Size);
  AudioOutputI2S* out = new AudioOutputI2S();
  AudioGeneratorMP3* mp3 = new AudioGeneratorMP3();

  out->SetPinout(SPK_BCLK_PIN, SPK_LRC_PIN, SPK_DIN_PIN);

  out->SetGain(SPEAKER_PLAYBACK_GAIN);

  if (!mp3->begin(file, out)) {
    Serial.println("MP3 begin failed.");
    delete mp3;
    delete out;
    delete file;
    return;
  }

  // Firmware-only speedup:
  // The backend TTS is usually 24 kHz MP3.
  // Forcing I2S output slightly faster makes speech play quicker.
  // Try 27600 for ~1.15x, 28800 for ~1.2x, 30000 for ~1.25x.
  out->SetRate(28800);

  Serial.println("MP3 playback started.");

  while (mp3->isRunning()) {
    updateStatusLed();
    if (!mp3->loop()) {
      mp3->stop();
    }

    delay(1);
  }

  Serial.println("MP3 playback finished.");

  delete mp3;
  delete out;
  delete file;

  parkSpeakerPins();
}

void playAudioUrlFromResponse(const String& response) {
  String audioUrl = extractAudioUrlFromResponse(response);

  if (audioUrl.length() == 0) {
    Serial.println("No audio.url in response.");
    return;
  }

  String fullUrl = makeAbsoluteAudioUrl(audioUrl);

  Serial.print("Full audio URL: ");
  Serial.println(redactSensitiveUrl(fullUrl));

  unsigned long downloadStartMs = millis();

  bool downloaded = downloadMp3ToMemory(fullUrl);

  unsigned long downloadEndMs = millis();

  if (DEBUG_TIMING) {
    Serial.print("TIMING MP3 download+dechunk ms: ");
    Serial.println(downloadEndMs - downloadStartMs);
  }

  if (downloaded) {
    unsigned long playbackStartMs = millis();

    playMp3FromMemory();

    unsigned long playbackEndMs = millis();

    if (DEBUG_TIMING) {
      Serial.print("TIMING MP3 playback ms: ");
      Serial.println(playbackEndMs - playbackStartMs);
    }
  }
}

// =====================
// API calls
// =====================

void handleApiResponse(int statusCode, const String& response, const char* label) {
  Serial.print(label);
  Serial.print(" HTTP status: ");
  Serial.println(statusCode);

  if (DEBUG_VERBOSE_API) {
    Serial.println("Raw response:");
    Serial.println(response);
  }

  if (statusCode >= 200 && statusCode < 300) {
    updateSessionFromResponse(response);
    printUsefulResponseFields(response);
    playAudioUrlFromResponse(response);
    flashSuccessThenReady();
  } else {
    Serial.print(label);
    Serial.println(" failed.");
    markError();
  }
}

bool uploadWavToApi() {
  setStatus(STATUS_THINKING);

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Cannot upload: Wi-Fi not connected.");
    return false;
  }

  if (!wavBuffer || wavSize == 0) {
    Serial.println("Cannot upload: WAV buffer is empty.");
    return false;
  }

  unsigned long uploadStartMs = millis();

  Serial.println();
  Serial.println("Uploading WAV voice query to API...");
  String apiUrl = withGatewayToken(String(API_URL_BASE));

  Serial.print("URL: ");
  Serial.println(redactSensitiveUrl(apiUrl));
  Serial.print("WAV bytes: ");
  Serial.println(wavSize);

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(30000);

  unsigned long httpBeginStartMs = millis();

  if (!http.begin(client, apiUrl)) {
    Serial.println("HTTP begin failed.");
    return false;
  }

  unsigned long httpBeginEndMs = millis();

  String boundary = "----RecipeHelperBoundary7MA4YWxkTrZu0gW";

  String bodyStart = "";
  bodyStart += "--" + boundary + "\r\n";
  bodyStart += "Content-Disposition: form-data; name=\"audio\"; filename=\"recording.wav\"\r\n";
  bodyStart += "Content-Type: audio/wav\r\n\r\n";

  String bodyMiddle = "";

  if (sessionId.length() > 0) {
    bodyMiddle += "\r\n--" + boundary + "\r\n";
    bodyMiddle += "Content-Disposition: form-data; name=\"sessionId\"\r\n\r\n";
    bodyMiddle += sessionId;
  }

  String bodyEnd = "";
  bodyEnd += "\r\n--" + boundary + "--\r\n";

  size_t totalLength =
    bodyStart.length() +
    wavSize +
    bodyMiddle.length() +
    bodyEnd.length();

  unsigned long multipartAllocStartMs = millis();

  uint8_t* multipartBody = (uint8_t*)ps_malloc(totalLength);
  if (multipartBody == nullptr) {
    Serial.println("PSRAM multipart allocation failed; trying regular heap...");
    multipartBody = (uint8_t*)malloc(totalLength);
  }

  if (multipartBody == nullptr) {
    Serial.println("ERROR: Could not allocate multipart body.");
    http.end();
    return false;
  }

  size_t offset = 0;

  memcpy(multipartBody + offset, bodyStart.c_str(), bodyStart.length());
  offset += bodyStart.length();

  memcpy(multipartBody + offset, wavBuffer, wavSize);
  offset += wavSize;

  if (bodyMiddle.length() > 0) {
    memcpy(multipartBody + offset, bodyMiddle.c_str(), bodyMiddle.length());
    offset += bodyMiddle.length();
  }

  memcpy(multipartBody + offset, bodyEnd.c_str(), bodyEnd.length());
  offset += bodyEnd.length();

  unsigned long multipartAllocEndMs = millis();

  http.addHeader("Content-Type", "multipart/form-data; boundary=" + boundary);
  http.addHeader("Accept", "application/json");

  Serial.print("Multipart bytes: ");
  Serial.println(totalLength);

  unsigned long postStartMs = millis();

  int statusCode = http.POST(multipartBody, totalLength);

  unsigned long postEndMs = millis();

  free(multipartBody);

  unsigned long readResponseStartMs = millis();

  String response = http.getString();

  unsigned long readResponseEndMs = millis();

  http.end();

  if (DEBUG_TIMING) {
    Serial.print("TIMING http.begin ms: ");
    Serial.println(httpBeginEndMs - httpBeginStartMs);

    Serial.print("TIMING multipart build ms: ");
    Serial.println(multipartAllocEndMs - multipartAllocStartMs);

    Serial.print("TIMING POST upload+server wait ms: ");
    Serial.println(postEndMs - postStartMs);

    Serial.print("TIMING read response ms: ");
    Serial.println(readResponseEndMs - readResponseStartMs);

    Serial.print("TIMING upload function before playback ms: ");
    Serial.println(readResponseEndMs - uploadStartMs);
  }

  handleApiResponse(statusCode, response, "Voice query");

  unsigned long uploadEndMs = millis();

  if (DEBUG_TIMING) {
    Serial.print("TIMING upload function total incl response audio playback ms: ");
    Serial.println(uploadEndMs - uploadStartMs);
  }

  return statusCode >= 200 && statusCode < 300;
}

bool sendNextStepToApi() {
  setStatus(STATUS_THINKING);

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Cannot send next_step: Wi-Fi not connected.");
    return false;
  }

  if (sessionId.length() == 0) {
    Serial.println("Cannot send next_step: no sessionId stored yet.");
    Serial.println("Use Talk first to load a recipe/session.");
    return false;
  }

  unsigned long nextStartMs = millis();

  Serial.println();
  Serial.println("Sending next_step to API...");
  String apiUrl = withGatewayToken(String(API_URL_BASE));

  Serial.print("URL: ");
  Serial.println(redactSensitiveUrl(apiUrl));
  if (DEBUG_VERBOSE_API) {
    Serial.print("sessionId: ");
    Serial.println(sessionId);
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(30000);

  unsigned long httpBeginStartMs = millis();

  if (!http.begin(client, apiUrl)) {
    Serial.println("HTTP begin failed.");
    return false;
  }

  unsigned long httpBeginEndMs = millis();

  http.addHeader("Content-Type", "application/json");
  http.addHeader("Accept", "application/json");

  String body = "{\"inputMode\":\"next_step\",\"sessionId\":\"" + sessionId + "\"}";

  if (DEBUG_VERBOSE_API) {
    Serial.println("JSON body:");
    Serial.println(body);
  }

  unsigned long postStartMs = millis();

  int statusCode = http.POST(body);

  unsigned long postEndMs = millis();

  String response = http.getString();

  unsigned long responseEndMs = millis();

  http.end();

  if (DEBUG_TIMING) {
    Serial.print("TIMING next http.begin ms: ");
    Serial.println(httpBeginEndMs - httpBeginStartMs);

    Serial.print("TIMING next POST+server wait ms: ");
    Serial.println(postEndMs - postStartMs);

    Serial.print("TIMING next read response ms: ");
    Serial.println(responseEndMs - postEndMs);

    Serial.print("TIMING next before playback ms: ");
    Serial.println(responseEndMs - nextStartMs);
  }

  handleApiResponse(statusCode, response, "next_step");

  unsigned long nextEndMs = millis();

  if (DEBUG_TIMING) {
    Serial.print("TIMING next total incl response audio playback ms: ");
    Serial.println(nextEndMs - nextStartMs);
  }

  return statusCode >= 200 && statusCode < 300;
}

// =====================
// Arduino lifecycle
// =====================

void setup() {
  Serial.begin(115200);

  pinMode(LED_R_PIN, OUTPUT);
  pinMode(LED_G_PIN, OUTPUT);
  pinMode(LED_B_PIN, OUTPUT);
  parkSpeakerPins();
  setStatus(STATUS_BOOTING);

  delay(3000);

  Serial.println();
  Serial.println("Recipe Helper: full Talk + Next + backend voice playback prototype.");
  Serial.println("STT improvement version: WAV header sample rate differs from mic I2S rate.");

  pinMode(TALK_BUTTON_PIN, INPUT_PULLUP);
  pinMode(NEXT_BUTTON_PIN, INPUT_PULLUP);

  Serial.print("Talk button pin: GPIO ");
  Serial.println(TALK_BUTTON_PIN);

  Serial.print("Next button pin: GPIO ");
  Serial.println(NEXT_BUTTON_PIN);

  Serial.print("Mic I2S sample rate: ");
  Serial.println(MIC_I2S_SAMPLE_RATE);

  Serial.print("WAV header sample rate: ");
  Serial.println(WAV_HEADER_SAMPLE_RATE);

  Serial.print("Max record seconds: ");
  Serial.println(MAX_RECORD_SECONDS);

  Serial.print("Upload PCM gain: ");
  Serial.println(UPLOAD_PCM_GAIN);

  Serial.print("Gateway token configured: ");
  Serial.println(String(GATEWAY_TOKEN).length() > 0 && String(GATEWAY_TOKEN) != "GATEWAY_TOKEN" ? "yes" : "no");

  connectWiFi();
  setupMicI2S();

  if (!allocateBuffers()) {
    Serial.println("Cannot continue without buffers.");
    return;
  }

  setStatus(STATUS_READY);

  Serial.println();
  Serial.println("Ready.");
  Serial.println("- Hold Talk to record/upload a voice query.");
  Serial.println("- Press Next to send next_step using stored sessionId.");
}

void loop() {
  updateStatusLed();

  if (pcmBuffer == nullptr || wavBuffer == nullptr) {
    delay(1000);
    return;
  }

  if (talkButtonPressed()) {
    delay(50);

    if (talkButtonPressed()) {
      Serial.println();
      Serial.println("Talk action started.");

      recordWhileTalkHeld();

      if (wavSize > 0) {
        uploadWavToApi();
      }

      if (currentStatus != STATUS_ERROR) {
        setStatus(STATUS_READY);
      }
      Serial.println("Talk action complete.");
    }
  }

  if (nextButtonPressed()) {
    delay(50);

    if (nextButtonPressed()) {
      Serial.println();
      Serial.println("Next action started.");

      sendNextStepToApi();

      waitForNextButtonRelease();

      if (currentStatus != STATUS_ERROR) {
        setStatus(STATUS_READY);
      }
      Serial.println("Next action complete.");
    }
  }

  delay(10);
}
