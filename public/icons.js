// The line icons used on every page, as inline SVG so they take the colour of the text around them.
const SPEAKER = '<path d="M4 9.5h3l4.5-4v13l-4.5-4H4z"/>';
const BELL = '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>';
const SHAPES = {
  heart: '<path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.4 4.5 6.9 4.5c2 0 3.6 1.1 5.1 3 1.5-1.9 3.1-3 5.1-3 3.5 0 5.5 3.5 4.2 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  comment: '<path d="M4 5h16v11.5h-9.5L6 20v-3.5H4z"/>',
  sound: `${SPEAKER}<path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.6 7.6 0 0 1 0 11"/>`,
  muted: `${SPEAKER}<path d="M16 9.5l5 5M21 9.5l-5 5"/>`,
  bell: BELL,
  bellOff: `${BELL}<path d="M4 4l16 16"/>`,
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.9 2.1c-.9.6-1.4 1.1-1.4 2.1"/><path d="M12 16.8v.2"/>',
  close:'<path d="M6 6l12 12M18 6L6 18"/>',
  flip: '<path d="M20 4.5v4h-4M4 12a8 8 0 0 1 13.7-5.6L20 8.5"/><path d="M4 19.5v-4h4M20 12a8 8 0 0 1-13.7 5.6L4 15.5"/>',
};

export function icon(name, size = 24) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const attrs = {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  svg.innerHTML = SHAPES[name];
  return svg;
}
