// Session helpers for fl_session cookie
// Used by passkeys finish handlers and dashboard routes.

export function setSessionCookie(token: string): string {
  return `fl_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`;
}

export function clearSessionCookie(): string {
  return `fl_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function getUserFromSession(request: Request, env: any): Promise<string | null> {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/fl_session=([^;]+)/);
  if (!match) return null;
  const token = match[1];
  // TODO: look up session token hash in D1 sessions table
  // For now return a stub; replace with real lookup + expiry check
  if (env.DB) {
    const row = await env.DB.prepare(
      'SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?'
    ).bind(await sha256(token), new Date().toISOString()).first();
    return row ? (row.user_id as string) : null;
  }
  return null;
}

async function sha256(text: string) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
