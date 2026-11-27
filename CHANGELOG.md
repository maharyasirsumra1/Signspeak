# Changelog

## Unreleased

- Add a React error boundary with a reload recovery screen, and snapshot SQLite migrations consistently in WAL mode with a regression test.
- Restrict calling to Super Admin-approved, phone-verified devices; add online/device presence, multi-session call claiming, installable PWA metadata, and HTTPS/TURN setup guidance.
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
- Add role- and permission-protected admin management, account/session actions, immutable audit logs, authentication history, and usage reporting.
- Reuse the SignSpeak floral dark-navy login layout for `/admin` while keeping administrator branding and role checks.
- Add an Admin Profile form to change username, email, display name, image, and password with password re-authentication and email re-verification.
- Allow active users to sign in immediately after registration without requiring email verification; keep email verification available for verified-account features.
- Add unique usernames to new and existing accounts, and allow username or email for user/admin sign-in and verification-link resend.
- Add privacy-limited feature telemetry, profile image URLs, and one-time password reset links with session revocation.
- Add additive SQLite admin migrations with automatic pre-migration backups and document the verified-account Super Admin bootstrap process.
