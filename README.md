# SignSpeak

SignSpeak is a React application for webcam-based sign recognition and accessible video conversations. Hand landmarks and the bundled word model run in the browser. Account, contact, call-signaling, and administrator data use a Node.js API and SQLite database.

## Features

- In-browser webcam recognition for the bundled 23-word classifier, with live subtitles, confidence scores, and a sentence builder.
- Camera controls, mirror and ghost modes, screenshots, text export, and optional speech output.
- Verified accounts, Google/Facebook sign-in when configured, Super Admin-approved calling devices, WebRTC calls, captions, text chat, and call history.
- A protected `/admin` console for account management, role/permission assignments, session revocation, reports, authentication and usage history, contact/call metadata, and append-only administrator audit logs.
- Admin actions are checked by the API as well as the interface. `super_admin` is provisioned from the server environment; other admins receive explicit permissions.

Recognition runs in the browser. Feature telemetry records action metadata only: it does not collect webcam video, microphone audio, sentence text, or call content. Authentication and feature events are retained for 90 days. Call recording is not enabled.

## Requirements and running locally

- Node.js 22.13 or newer (the backend uses Node's built-in `node:sqlite`)
- npm
- A webcam and internet access for the first load (MediaPipe assets are loaded from a CDN)

```bash
npm install
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://127.0.0.1:5173`). Create an account with a unique username, email, and password. You can sign in immediately without verifying email; verification is still needed for verified-account features such as Super Admin bootstrap and approved calling. In development, new accounts receive an optional verification link in the app. Browser camera and microphone permissions are needed for recognition and calls.

## Cross-device calling

The app is installable as a PWA from a supported mobile browser. A Super Admin must add an existing, email-verified account under **Approved Call Devices**, record its E.164 phone number and device label, manually confirm the number, and enable calling. Users cannot add or approve phone numbers. This build has no SMS/OTP provider, so the phone check is an administrator attestation rather than an automated phone challenge.

The approved directory shows account presence from authenticated WebSocket sessions. Calls use browser WebRTC; camera and microphone access starts only after the recipient accepts. Incoming calls ring all active sessions for that account, and accepting on one device dismisses the invitation on its other sessions. Browser notifications can be enabled while SignSpeak is running. Background push delivery when the browser/app is closed is not configured; mobile users must keep SignSpeak open to receive calls.

For laptop-to-phone testing, serve SignSpeak from a network-reachable host over HTTPS with a certificate trusted by both devices. Browser camera/microphone APIs are blocked on ordinary HTTP LAN origins. For local Vite development, set `HOST=0.0.0.0`, set `DEV_TLS_CERT_PATH` and `DEV_TLS_KEY_PATH` for HTTPS, and set `TRUST_PROXY=1` for the local Vite-to-API proxy. Configure a public TURN service with `TURN_URLS` and `TURN_SHARED_SECRET` for reliable calls across NATs and restrictive networks. STUN alone cannot guarantee connectivity on every network. Calls are SignSpeak-to-SignSpeak over the internet and do not use PSTN dialing.

Useful checks:

```bash
npm run build
npm run test:server
```

## Administrator setup

1. Register the account that should become Super Admin using the email and password you want to use.
2. Verify that email; verification is required to bootstrap a Super Admin.
3. Stop the running SignSpeak server.
4. Copy `.env.example` to `.env` if needed and set `SUPER_ADMIN_EMAIL` to that account's exact email address.
5. Restart SignSpeak. The server verifies that the address belongs to an existing verified account, then grants the `super_admin` role. Remove the environment setting after bootstrap if preferred; the database role remains.

There is no shared/default admin email or password. Sign in at `/admin` using the account credentials chosen at registration. Under **Admin Profile**, an administrator can change their username, email, and password. Changing username, email, or password requires the current password; an email change sends a verification link and revokes other active sessions. Do not put credentials in the frontend or commit `.env`. Admins can be promoted by a Super Admin and must be assigned explicit permissions. Password reset links are single-use, expire after 30 minutes, and revoke the account's existing sessions.

Schema migrations are applied additively when the API starts. Before changing an existing database, the migration creates a timestamped backup in `server/data/backups/`. The default database is `server/data/signspeak.sqlite`; set `SIGNSPEAK_DB_PATH` to use another file.

## Server configuration

| Variable | Purpose |
| --- | --- |
| `HOST`, `PORT` | Backend bind address and port; defaults to `127.0.0.1:3001`. |
| `DEV_TLS_CERT_PATH`, `DEV_TLS_KEY_PATH` | Optional trusted TLS certificate and key for HTTPS from the Vite development server. |
| `SIGNSPEAK_DB_PATH` | SQLite database path. |
| `PUBLIC_ORIGIN` | Canonical app origin for verification and password-reset links. |
| `SUPER_ADMIN_EMAIL` | Optional existing, verified account email for Super Admin bootstrap. |
| `GOOGLE_CLIENT_ID` | Google Identity Services OAuth client ID. |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | Meta app credentials; keep the secret server-side. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | Required for production verification and password-reset email. Optional `SMTP_FROM` sets the sender address. |
| `TURN_URLS`, `TURN_SHARED_SECRET` | Optional TURN service settings for reliable WebRTC calls. Keep the shared secret private. |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | TLS certificate and key when Node terminates HTTPS. |
| `TRUST_PROXY=1` | Use only behind a trusted HTTPS reverse proxy that sets `X-Forwarded-Proto`. |

For production, serve the built `dist` files over HTTPS and proxy `/api` and `/api/signaling` to the backend over a trusted connection. Set `NODE_ENV=production`, `PUBLIC_ORIGIN`, and SMTP settings. Configure TURN for calls across restrictive networks. The other participant and STUN/TURN providers may learn connection metadata such as IP addresses.

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
| E | Export the sentence |
| Backspace | Delete the last sentence word, except while editing a form field |

## Known limitations

- The bundled classifier recognizes 23 word labels; it does not recognize ASL A-Z. Accuracy figures are not measured results in this repository.
- Dataset Studio currently records 126-value, 30-frame samples, while live recognition uses 138 values over 32 frames. Do not train a model from browser-recorded data until this mismatch is resolved.
- Ghost mode is a grid preview, not person segmentation. Call recording capture and protected storage are not implemented.
- MediaPipe assets are loaded from `cdn.jsdelivr.net` and `storage.googleapis.com`, so first-time use requires internet access.
- Text-to-speech and some other features depend on browser support.

## Project structure

```text
src/
  App.jsx                  Recognition UI, camera loop, sentence builder, Dataset Studio
  components/AccountShell  Authentication, contacts, calls, and app routing
  components/admin/        Administrator console
  utils/features.js        138-value feature extraction and mirror handling
  utils/signModel.js       Browser inference engine
server/
  index.js                 HTTP/WebSocket API and authentication
  db.js                    SQLite schema and additive migrations
  admin.js                 Admin APIs, permissions, audit and activity metadata
public/
  model_weights.json       Trained model weights
  labels.json              Model labels
```
