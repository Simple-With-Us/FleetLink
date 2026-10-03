export const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export function cleanPath(input: string): string | null {
  if (!input || input.length > 512 || input.includes('\\') || input.includes('\0') || input.startsWith('/')) return null;
  const parts = input.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[\x00-\x1f\x7f]/.test(p))) return null;
  return parts.join('/');
}
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}
export function contentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  return ({html:'text/html; charset=utf-8',htm:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',json:'application/json; charset=utf-8',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',ico:'image/x-icon',txt:'text/plain; charset=utf-8',pdf:'application/pdf',wasm:'application/wasm'} as Record<string,string>)[ext || ''] || 'application/octet-stream';
}
export const hexOf = (a: Uint8Array) => Array.from(a, v => v.toString(16).padStart(2, '0')).join('');
export const randomToken = (bytes = 32) => hexOf(crypto.getRandomValues(new Uint8Array(bytes)));
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export async function sha256Hex(value: string): Promise<string> {
  return hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
export function jwtClaims(jwt: string): Record<string, unknown> | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try { const v = JSON.parse(new TextDecoder().decode(b64urlDecode(part))); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
