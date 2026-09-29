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
