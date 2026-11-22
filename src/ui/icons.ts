/** Icon set A from the prototype: one component, paths as data. */
import { h } from 'preact';
const P: Record<string, string> = {folder:'<path d="M3.5 7.5a2 2 0 0 1 2-2h3.9l2.1 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',filter:'<path d="M4 5.5h16l-6.2 7.2v5.6l-3.6-1.8v-3.8z"/>',home:'<path d="M4 11.5 12 5l8 6.5"/><path d="M6 10v9h12v-9"/>',plus:'<path d="M12 5v14M5 12h14"/>',clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',search:'<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    up:'<path d="M12 19V6m-6 6 6-6 6 6"/>',down:'<path d="M12 5v13m6-6-6 6-6-6"/>',trash:'<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    // reading mode's zoom out
    minus:'<path d="M5 12h14"/>',
    prev:'<path d="m15 6-6 6 6 6"/>',next:'<path d="m9 6 6 6-6 6"/>',close:'<path d="M6 6l12 12M18 6 6 18"/>',chevup:'<path d="m18 15-6-6-6 6"/>',tag:'<path d="M12.6 2.6 21.4 11.4a2 2 0 0 1 0 2.8l-7.2 7.2a2 2 0 0 1-2.8 0L2.6 12.6A2 2 0 0 1 2 11.2V4a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',flag:'<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 8 2a6 6 0 0 0 3.6-1.2 1 1 0 0 1 1.4.8v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.4"/>',user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',cal:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',chev:'<path d="m6 9 6 6 6-6"/>',building:'<path d="M3 21h18M5 21V4h10v17M15 9h4v12M8.5 8.5h3M8.5 13h3"/>',chevr:'<path d="m9 6 6 6-6 6"/>',
    // a paper airplane pointing top right, moved 1 down and 1 left so it sits centered by eye
    send:'<path d="M20 4 2 11.5l7 3 3 7.5L20 4Z"/><path d="M20 4 9 14.5"/>',
    more:'<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
    clip:'<path d="m21 11.5-8.5 8.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7'
      + 'L10.2 17.7a1.6 1.6 0 0 1-2.3-2.3L15.5 8"/>',
    doc:'<path d="M7 2h7l6 6v14H7a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Z"/><path d="M14 2v6h6"/>',memo:'<path d="M7 2h7l6 6v14H7a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Z"/><path d="M14 2v6h6M8.5 13h7M8.5 17h5"/>',
    cached:'<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>',stop:'<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
    model:'<path d="M4 7h10M18 7h2M4 12h3M11 12h9M4 17h12M20 17h0"/><circle cx="16" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="18" cy="17" r="2"/>',
    gear:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    edit:'<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13 7 4 4"/>',check:'<path d="m5 12 5 5L20 7"/>',import:'<path d="M12 4v10m-4-4 4 4 4-4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',checkbox:'<rect x="4" y="4" width="16" height="16" rx="4"/>',checkfill:'<rect x="4" y="4" width="16" height="16" rx="4" fill="currentColor" stroke="none"/><path d="m8 12 3 3 5-6" stroke="var(--accent-ink)"/>',mark:'<path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',sheet:'<path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z"/><path d="M4 9h16M4 15h16M10 3v18"/>',logedit:'<path d="M11 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5"/><path d="M4 9h16M10 4v16"/><path d="m14.5 21 .8-2.8 4.2-4.2 2 2-4.2 4.2z"/>',
    // a notice about something that did not happen (notice.tsx), and a folder not found on this PC in Locate Deal
    // Folders: a triangle with "!"
    warn: '<path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/>'
      + '<path d="M12 9.5v4M12 17h.01"/>',
    unlisted:'<path d="M3 5h15M3 11h9M3 17h6M14 13l7 7M21 13l-7 7"/>',copy:'<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',addq:'<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12Z"/><path d="M12 8.5v6M9 11.5h6"/>',addf:'<path d="M5 21V4.5a.5.5 0 0 1 .3-.4A5 5 0 0 1 8 3.5c2.5 0 4 1.5 6.5 1.5a5 5 0 0 0 2.7-.6.5.5 0 0 1 .8.4v8.3a.5.5 0 0 1-.3.4 5 5 0 0 1-3.2 1c-2.5 0-4-1.5-6.5-1.5a5 5 0 0 0-3 .9"/><path d="M19 17v6M16 20h6"/>',stack:'<path d="m12 4 8 4-8 4-8-4z"/><path d="m4 12 8 4 8-4"/><path d="m4 16 8 4 8-4"/>',use:'<path d="M4 4v7a4 4 0 0 0 4 4h12"/><path d="m15 10 5 5-5 5"/>'};
export function Icon({ name, size = 16, sw = 1.75 }: { name: string; size?: number; sw?: number }) {
  const d = P[name] ?? '';
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', dangerouslySetInnerHTML: { __html: d } });
}
export const iconNames = Object.keys(P);
