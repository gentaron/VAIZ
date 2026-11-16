/** Reject untrusted, credentialed, and internal URLs before they enter a video brief.
 * These links are evidence references, not instructions or network targets.
 */
export function isPublicHttpsSource(input) {
  if (typeof input !== 'string' || !input || /\s/.test(input)) return false;
  let url;
  try { url = new URL(input); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local')
      || host.endsWith('.internal') || host.endsWith('.test.internal')) return false;
  // Do not authorize numeric hosts or IPv6 literal targets from untrusted briefs.
  // DNS rebinding is still possible: consumers must separately restrict actual fetches.
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return false;
  return true;
}
