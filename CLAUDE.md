# Altwise

Hackathon entry for #BuildHybridAI 2026 (Google / Firebase AI Logic, on Devpost).
Owner: Abhishek (solo). Read PLAN.md and HACKATHON.md before doing anything.

## What we are building
A Chrome extension (Manifest V3, side panel) that audits the images on any web page
for accessibility and writes alt text. Audience: people who publish school and
local-government web pages.

- On device (Gemini Nano via Firebase AI Logic): classify each image as
  decorative / informative / complex (enum structured output) and draft short alt text.
- Cloud (Gemini via Firebase AI Logic): long descriptions for complex images
  (charts, infographics) and checks on linked PDFs (PDF input is cloud only).
- Every result shows a badge: "on device" or "cloud". A counter shows how many
  images were handled locally vs sent to cloud. Judges score hybrid use, so it must be visible.

## Hard rules (from the hackathon)
- ALL AI inference goes through the Firebase AI Logic SDK (`firebase/ai`). No direct
  Prompt API calls, no other AI providers.
- Firebase App Check is required. Debug tokens are fine, but NEVER commit a debug
  token, API secret or service-account file. Keep them in `.env.local` (gitignored).
- Public GitHub repo, Apache-2.0 license visible in the repo About section.
- Target the $3,000 "Best Web/Chrome App" prize. Do not add Android or iOS.

## Stack (keep it small)
- Vite + TypeScript, no UI framework unless it clearly saves time.
- Firebase JS SDK: AI Logic (hybrid), App Check. Add Auth, Firestore and
  Remote Config only after the core audit flow works.
- No backend server.

## On-device model limits to design around
- Input: text, plus JPEG/PNG images as inline data. No audio, video or PDF.
- Single-turn only. No chat, no tools/function calling on device.
- Structured output (JSON, enums) and streaming work on device.
- `initializeDeviceModel()` must be called after a user click, before any prompt.
- PREFER_ON_DEVICE falls back to cloud while the model is missing or downloading.
- Expect slow CPU inference: process images one at a time, show progress.

## Working preferences
- Simplest thing that works. Fewest files. No speculative abstractions.
- Share the plan before large changes.
- Writing (README, Devpost text, video script) must sound human: no em-dash
  stacking, no three-part parallel lists, no generic mission openers.

## Current status
Built and working: extension, hosted try page (altwise.web.app), demo pages, tests.
On-device quality was checked with Gemini Nano on a cloud VM. Remaining work is tracked
in PLAN.md (kept local).
