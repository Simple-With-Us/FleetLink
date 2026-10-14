/**
 * Uploaded HTML must download, never render on a FleetLink origin.
 * Extension checks alone miss a stored text/html type on a non-.html key
 * (payload.html.bak, notes.xhtml).  Both signals force an attachment.
 */

export function isHtmlExtension(key) {
  const base = String(key || "").split("/").pop()?.toLowerCase() || "";
  return base.endsWith(".html") || base.endsWith(".htm");
}

export function isHtmlContentType(contentType) {
  if (!contentType) return false;
  const value = String(contentType).toLowerCase();
  return value.includes("text/html") || value.includes("application/xhtml+xml");
}

/** True when the object must be served as an octet-stream attachment. */
export function mustForceAttachment(key, contentType) {
  return isHtmlExtension(key) || isHtmlContentType(contentType);
}
