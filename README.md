# SignSpeak

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

```bash
npm install
npm run dev
```

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