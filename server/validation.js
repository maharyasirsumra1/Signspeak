export function cleanProfileImageUrl(value) {
  if (value === null || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Profile image URL must be a valid HTTPS URL under 2048 characters.');
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('Profile image URL must be a valid HTTPS URL under 2048 characters.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Profile image URL must use HTTPS and cannot include credentials.');
  }
  return parsed.toString();
}
