# SignSpeak

<<<<<<< HEAD
Real-time sign-language recognition in the browser, with live subtitles and a sentence builder.

SignSpeak reads hand signs from your webcam and shows each recognised word as a subtitle. Words can be built into a sentence, copied, exported as a text file, or read aloud. Recognition runs entirely in the browser: video frames are not sent to a server.

## Demo

TODO before submission: add the deployed link and the 60-second demo video.

## Feature status

| Feature | Status |
| --- | --- |
| Webcam capture and 21-point hand tracking (MediaPipe Hand Landmarker, GPU with CPU fallback) | Implemented |
| In-browser neural recognition of 23 words | Implemented. Accuracy not yet measured in this repository |
| Live HUD with confidence, stability, FPS and latency | Implemented |
| Subtitles with held-sign suppression and an "Uncertain - please repeat" state | Implemented |
| Sentence builder: add space, delete last word, clear, capitalise, copy, export as .txt | Implemented |
| Read the sentence aloud (Web Speech API) | Implemented. Depends on browser support |
| Screenshot that follows the current Mirror and Ghost settings | Implemented |
| Caption size: small, medium, large | Implemented |
| Hand mode (both, right, left), mirror view, ghost mode | Implemented |
| Dataset Studio: record and export samples | Partial. Recorded format differs from live recognition (see Known limitations) |
| Accessibility: keyboard shortcuts, focus rings, live subtitle region | Partial. Caption contrast and position are not yet adjustable |
| Two-user video calling with WebRTC | Planned |
| Live sign captions during calls | Planned |
| Call history and consent-based recording | Planned |
| Accounts and backend (authentication, contacts) | Planned |
| A to Z alphabet recognition | Planned |
| Gesture-controlled visual effects mode | Planned |

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| P | Pause or resume detection |
| S | Save a screenshot |
| R | Switch between Live and Record tabs |
| L | Show or hide landmarks |
| K | Show or hide skeleton lines |
| H | Show or hide the HUD |
| C | Clear the current subtitle |
| X | Copy the current word |
| G | Toggle ghost mode |
| E | Export the sentence as a text file |
| Backspace | Delete the last word in the sentence |

## Getting started

Requirements:
- Node.js 18.18 or newer (20 LTS recommended)
- A webcam
- An internet connection the first time the app loads. The MediaPipe runtime and model are downloaded from a CDN.
=======
SignSpeak is a React application for webcam-based sign recognition and accessible video conversations. Hand landmarks and the bundled word model run in the browser. Account, contact, and call-signaling data use the Node.js API and SQLite database.

## Current implementation status

- The bundled classifier recognizes 23 word labels; it does not recognize ASL A-Z.
- Account registration, email verification, sign-in/out, profile editing, account deletion, and contact requests are implemented.
- Accepted contacts can start WebRTC video/audio calls. Sign captions, optional speech-to-text captions, text chat, call history, and basic call controls are available.
- The default development email flow provides a local verification link. Production email delivery requires SMTP.
- Recording is **not enabled**. The call UI can exchange consent requests and responses, but does not capture, store, encrypt, play, or delete recordings.
- Ghost mode is a grid preview, not person segmentation. Calibration and gesture-controlled visual effects are not implemented.
- Accuracy targets are not measured results. A-Z recognition and accuracy claims require a valid labeled dataset, compatible trained weights, and signer/session-separated evaluation.
- WebRTC uses public STUN by default. Configure a TURN service for reliable calls across restrictive networks. The other participant and STUN/TURN providers may learn connection metadata such as IP addresses.

## Requirements

- Node.js 22.13 or newer (the backend uses Node's built-in `node:sqlite`).
- npm.

## Install and run
>>>>>>> 27de5da (Update SignSpeak project)

```bash
npm install
npm run dev
```

<<<<<<< HEAD
Open http://localhost:5173 and allow camera access.

To create a production build:

```bash
npm run build
npm run preview
```

## How it works

1. The webcam frame goes to MediaPipe Hand Landmarker, which returns 21 points per hand.
2. For each frame, `src/utils/features.js` builds 138 values: relative hand coordinates for both hands, wrist positions, and wrist velocity.
3. While a hand is visible, frames are collected (up to 3 seconds) and resampled to a 32-frame window.
4. `src/utils/signModel.js` runs the trained model in plain JavaScript: Conv1D, BatchNorm, Bidirectional GRU, Dense, and softmax over 23 words.
5. A prediction with confidence of 0.5 or more becomes a subtitle. Lower-confidence results show "Uncertain - please repeat".

## Project structure

```
src/
  App.jsx              UI, camera loop, recognition state, Dataset Studio
  main.jsx             React entry point
  index.css            Global styles and Tailwind layers
  utils/
    features.js        138-value feature extraction and mirror handling
    signModel.js       Browser inference engine for the trained model
    db.js              IndexedDB storage for recorded samples
public/
  model_weights.json   Trained model weights (Keras export)
  labels.json          The 23 word labels
```

## Known limitations

- **Accuracy:** The 84% and 84.4% figures are team-reported. This repository does not yet include the training or evaluation code, so these numbers are not reproduced here.
- **Dataset Studio:** Samples recorded in the browser use a 126-value format (30 frames, no wrist features or velocity, no mirror correction). Live recognition uses 138 values over 32 frames. Do not train a model from browser-recorded data until this is fixed. The issue is marked with a TODO in `src/utils/db.js`.
- **Network:** The MediaPipe runtime and model are loaded from cdn.jsdelivr.net and storage.googleapis.com, so the app needs internet on first load.
- **Browser support:** Text-to-speech and some other features depend on the browser.
- **Tests:** There are no automated tests yet. The build (`npm run build`) is the only check.

## License

To be decided by the team before publishing.
=======
Open the Vite URL printed in the terminal (normally `http://127.0.0.1:5173`). In development, newly registered accounts receive a verification link in the app; follow it, then sign in. Browser camera and microphone permissions are needed for recognition and calls.

Run the backend alone with `npm run server`. Run the targeted backend checks with `npm run test:server`. Create a production frontend bundle with `npm run build`.

## Server configuration

| Variable | Purpose |
| --- | --- |
| `HOST` | Backend bind address; defaults to `127.0.0.1`. |
| `PORT` | Backend port; defaults to `3001`. |
| `SIGNSPEAK_DB_PATH` | SQLite file path; defaults to `server/data/signspeak.sqlite`. |
| `PUBLIC_ORIGIN` | Canonical public app origin used for origin checks and verification links. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | Required for production email verification. Optional `SMTP_FROM` sets the sender address. |
| `TURN_URLS` | Comma-separated TURN URLs, for example `turn:turn.example.net:3478?transport=udp`. |
| `TURN_SHARED_SECRET` | TURN REST shared secret; used server-side to issue short-lived credentials. Keep it private. |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | TLS certificate/key when Node terminates HTTPS directly. |
| `TRUST_PROXY=1` | Use only behind a trusted HTTPS reverse proxy that sets `X-Forwarded-Proto`. |

For production, serve the built `dist` files over HTTPS and proxy `/api` and `/api/signaling` to the backend over a trusted connection. Set `NODE_ENV=production`, `PUBLIC_ORIGIN`, and SMTP settings. Configure TURN for dependable calls. Keep the SQLite database and server secrets protected and backed up. Do not expose `TURN_SHARED_SECRET` or SMTP credentials to frontend code.
>>>>>>> 27de5da (Update SignSpeak project)
