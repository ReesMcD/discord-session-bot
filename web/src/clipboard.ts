/**
 * Copies text in the Mac app, in secure contexts, and over plain HTTP (the phone via Tailscale),
 * where navigator.clipboard doesn't exist and the old execCommand route is the only one.
 */
export async function copyText(text: string): Promise<void> {
  if (window.sessionBot) return window.sessionBot.copy(text);
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text);
  const area = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
  Object.assign(area.style, { position: 'fixed', top: '0', left: '0', opacity: '0' });
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length); // iOS needs an explicit range
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('Copy is blocked by this browser; select the text and copy it by hand');
}
