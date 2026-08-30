export function xsrfTokenFromCookie(cookie) {
  const match = String(cookie || '').match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}
