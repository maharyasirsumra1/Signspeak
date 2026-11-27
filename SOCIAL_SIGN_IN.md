# Google and Facebook sign-in setup

1. In Google Cloud Console, create an OAuth 2.0 Client ID with application type **Web application**. Add the SignSpeak development URL under **Authorized JavaScript origins** (for example, `http://127.0.0.1:5177`).
2. In Meta for Developers, create an app, add **Facebook Login**, and configure its website platform for the same SignSpeak origin.
3. Run `Copy-Item .env.example .env` in PowerShell. Set `GOOGLE_CLIENT_ID`, `FACEBOOK_APP_ID`, and `FACEBOOK_APP_SECRET` using the values from those provider consoles. Never expose the Facebook App Secret in frontend code or commit it.
4. Restart SignSpeak with `npm run dev`. If Google OAuth consent is in testing mode, add your Google account as a test user.

The backend verifies Google's signed ID token and checks Facebook access tokens against Meta before creating a SignSpeak session. A provider email matching an existing SignSpeak account is linked, so either configured provider can sign in to that account.
