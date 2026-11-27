const FACEBOOK_GRAPH_URL = 'https://graph.facebook.com/v27.0';

export async function verifyFacebookAccessToken(accessToken, appId, appSecret, fetchImpl = fetch) {
  if (
    typeof accessToken !== 'string'
    || accessToken.length > 4096
    || typeof appId !== 'string'
    || typeof appSecret !== 'string'
    || !appId
    || !appSecret
  ) {
    throw facebookAuthError(401, 'Facebook sign-in could not be verified. Please try again.');
  }

  const debugUrl = new URL(`${FACEBOOK_GRAPH_URL}/debug_token`);
  debugUrl.searchParams.set('input_token', accessToken);
  const debugResult = await graphRequest(debugUrl, `Bearer ${appId}|${appSecret}`, fetchImpl);
  const tokenData = debugResult?.data;
  const now = Math.floor(Date.now() / 1000);
  if (
    tokenData?.is_valid !== true
    || String(tokenData.app_id) !== appId
    || typeof tokenData.user_id !== 'string'
    || !Number.isFinite(tokenData.expires_at)
    || tokenData.expires_at <= now
    || !Array.isArray(tokenData.scopes)
    || !tokenData.scopes.includes('email')
  ) {
    throw facebookAuthError(401, 'Facebook sign-in could not be verified. Please try again.');
  }

  const profileUrl = new URL(`${FACEBOOK_GRAPH_URL}/me`);
  profileUrl.searchParams.set('fields', 'id,name,email');
  const profile = await graphRequest(profileUrl, `Bearer ${accessToken}`, fetchImpl);
  if (
    !profile
    || typeof profile !== 'object'
    || typeof profile.id !== 'string'
    || profile.id !== tokenData.user_id
    || typeof profile.email !== 'string'
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)
    || profile.email.length > 254
  ) {
    throw facebookAuthError(400, 'Facebook did not provide a usable email. Allow the email permission and try again.');
  }

  return {
    subject: profile.id,
    email: profile.email.trim().toLowerCase(),
    displayName: typeof profile.name === 'string' ? profile.name : ''
  };
}

async function graphRequest(url, accessToken, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: accessToken },
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    throw facebookAuthError(503, 'Facebook sign-in is temporarily unavailable. Please try again.');
  }

  if (!response.ok) {
    throw facebookAuthError(
      response.status === 400 || response.status === 401 ? 401 : 503,
      response.status === 400 || response.status === 401
        ? 'Facebook sign-in could not be verified. Please try again.'
        : 'Facebook sign-in is temporarily unavailable. Please try again.'
    );
  }

  try {
    return await response.json();
  } catch {
    throw facebookAuthError(503, 'Facebook sign-in is temporarily unavailable. Please try again.');
  }
}

function facebookAuthError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
