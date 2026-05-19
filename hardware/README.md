# Physical Board Assets

This directory is for the countertop cooking companion board, not the Pinata
agent runtime.

The Pinata/OpenClaw template lives in the application and workspace files at the
repo root. The files here are companion materials for building and flashing the
physical ESP32-S3 device that talks to that backend.

## Contents

- `cooking-companion-sketch/` - Arduino firmware for the ESP32-S3 board.
- `reference/recipe_helper_hardware_reference.pdf` - hardware reference PDF for
  the physical recipe helper prototype.

## Backend Relationship

The board firmware expects this template, or a compatible deployed agent, to
serve the voice API at:

- `POST /app/query-audio`

Configure the sketch with the deployed backend origin and, when required, the
Pinata gateway token before flashing it to hardware.
