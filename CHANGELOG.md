# Changelog

## Unreleased

- Prevent a held sign from repeatedly adding the same recognized word, and show timed feedback for uncertain signs with confidence percentages for accepted words.
- Make screenshots honor the current Mirror and Ghost settings.
- Add an ordered sentence builder with spacing, delete, clear, copy, and text export actions; add the E export and Backspace delete shortcuts.
- Add accessible toggle states, live subtitle announcements, icon-only button labels, and visible keyboard focus rings.
- Remove unused Lucide imports and document the existing 126-value data pipeline mismatch.
- Add camera selection and explicit camera start/stop controls, with clearer disconnected-camera feedback.
- Clarify that grid preview hides the camera feed, and document the current 23-label model scope and unimplemented roadmap items.
- Add a Node.js/SQLite backend for verified accounts, session cookies, profiles, contacts, account deletion, and per-user call history; add the development launcher and API/WebSocket proxy.
- Add authenticated WebRTC signaling, sign/speech caption relay, text chat, call controls, and account/contact/call-history interfaces.
- Add recording consent exchange only; recording capture and protected storage remain unavailable. A-Z recognition, calibrated segmentation, TURN-backed deployment, and accuracy evaluation still require external models, configuration, or data.
