import { deflateSync } from 'node:zlib';

// Radar-style map: north up, centered on the players. In PZ, x grows east and y grows south.
const SIZE = 512;
const SCALE = 2; // Drawn at double size, then averaged down to smooth the edges.
const CANVAS = SIZE * SCALE;
const COLORS = {
  background: [18, 22, 28], ring: [46, 56, 68], axis: [34, 42, 52], label: [150, 163, 178],
  text: [232, 236, 240], herd: [226, 62, 62], estimated: [240, 180, 50], route: [240, 180, 50],
  player: [80, 165, 255], link: [110, 122, 138], band: [28, 34, 42],
};
const COMPASS = ['Leste', 'Sudeste', 'Sul', 'Sudoeste', 'Oeste', 'Noroeste', 'Norte', 'Nordeste'];

export function compass(dx, dy) {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;
  const octant = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return COMPASS[((octant % 8) + 8) % 8];
}

// Five columns by seven rows; each string is one row.
const FONT = {
  A: '01110,10001,10001,11111,10001,10001,10001', B: '11110,10001,10001,11110,10001,10001,11110',
  C: '01110,10001,10000,10000,10000,10001,01110', D: '11110,10001,10001,10001,10001,10001,11110',
  E: '11111,10000,10000,11110,10000,10000,11111', F: '11111,10000,10000,11110,10000,10000,10000',
  G: '01110,10001,10000,10111,10001,10001,01111', H: '10001,10001,10001,11111,10001,10001,10001',
  I: '01110,00100,00100,00100,00100,00100,01110', J: '00111,00010,00010,00010,00010,10010,01100',
  K: '10001,10010,10100,11000,10100,10010,10001', L: '10000,10000,10000,10000,10000,10000,11111',
  M: '10001,11011,10101,10101,10001,10001,10001', N: '10001,11001,10101,10011,10001,10001,10001',
  O: '01110,10001,10001,10001,10001,10001,01110', P: '11110,10001,10001,11110,10000,10000,10000',
  Q: '01110,10001,10001,10001,10101,10010,01101', R: '11110,10001,10001,11110,10100,10010,10001',
  S: '01111,10000,10000,01110,00001,00001,11110', T: '11111,00100,00100,00100,00100,00100,00100',
  U: '10001,10001,10001,10001,10001,10001,01110', V: '10001,10001,10001,10001,10001,01010,00100',
  W: '10001,10001,10001,10101,10101,11011,10001', X: '10001,10001,01010,00100,01010,10001,10001',
  Y: '10001,10001,01010,00100,00100,00100,00100', Z: '11111,00001,00010,00100,01000,10000,11111',
  0: '01110,10001,10011,10101,11001,10001,01110', 1: '00100,01100,00100,00100,00100,00100,01110',
  2: '01110,10001,00001,00110,01000,10000,11111', 3: '11110,00001,00001,01110,00001,00001,11110',
  4: '00010,00110,01010,10010,11111,00010,00010', 5: '11111,10000,11110,00001,00001,10001,01110',
  6: '00110,01000,10000,11110,10001,10001,01110', 7: '11111,00001,00010,00100,01000,01000,01000',
  8: '01110,10001,10001,01110,10001,10001,01110', 9: '01110,10001,10001,01111,00001,00010,01100',
  ' ': '00000,00000,00000,00000,00000,00000,00000', '-': '00000,00000,00000,11111,00000,00000,00000',
  '.': '00000,00000,00000,00000,00000,01100,01100', ',': '00000,00000,00000,00000,01100,00100,01000',
  ':': '00000,01100,01100,00000,01100,01100,00000', '_': '00000,00000,00000,00000,00000,00000,11111',
  '/': '00001,00001,00010,00100,01000,10000,10000', '(': '00010,00100,01000,01000,01000,00100,00010',
  ')': '01000,00100,00010,00010,00010,00100,01000', '?': '01110,10001,00001,00110,00100,00000,00100',
};

// The font has no accents and player names can contain anything.
function fontText(value, max = 40) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().slice(0, max);
}

class Canvas {
  constructor() {
    this.pixels = new Uint8Array(CANVAS * CANVAS * 3);
    for (let i = 0; i < this.pixels.length; i += 3) this.pixels.set(COLORS.background, i);
  }
  dot(x, y, color) {
    const px = Math.round(x), py = Math.round(y);
    if (px < 0 || py < 0 || px >= CANVAS || py >= CANVAS) return;
    this.pixels.set(color, (py * CANVAS + px) * 3);
  }
  rect(x, y, width, height, color) {
    for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) this.dot(px, py, color);
  }
  disc(cx, cy, radius, color) {
    const r = radius * SCALE;
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) this.dot(cx * SCALE + x, cy * SCALE + y, color);
  }
  line(x0, y0, x1, y1, color, width = 1, dash = 0) {
    const length = Math.hypot(x1 - x0, y1 - y0), steps = Math.ceil(length * SCALE);
    const half = width * SCALE / 2;
    for (let i = 0; i <= steps; i++) {
      if (dash && Math.floor(i / SCALE / dash) % 2) continue;
      const t = steps ? i / steps : 0;
      const px = (x0 + (x1 - x0) * t) * SCALE, py = (y0 + (y1 - y0) * t) * SCALE;
      for (let oy = -half; oy <= half; oy++) for (let ox = -half; ox <= half; ox++) if (ox * ox + oy * oy <= half * half) this.dot(px + ox, py + oy, color);
    }
  }
  ring(cx, cy, radius, color, width = 1, dash = 0) {
    const steps = Math.ceil(2 * Math.PI * radius * SCALE);
    const half = width * SCALE / 2;
    for (let i = 0; i < steps; i++) {
      if (dash && Math.floor(i / SCALE / dash) % 2) continue;
      const angle = i / steps * 2 * Math.PI;
      const px = (cx + Math.cos(angle) * radius) * SCALE, py = (cy + Math.sin(angle) * radius) * SCALE;
      for (let oy = -half; oy <= half; oy++) for (let ox = -half; ox <= half; ox++) if (ox * ox + oy * oy <= half * half) this.dot(px + ox, py + oy, color);
    }
  }
  textWidth(value, size) { return fontText(value).length * 6 * size - size; }
  text(value, x, y, color, size = 1) {
    let cursor = x;
    for (const ch of fontText(value)) {
      const rows = (FONT[ch] ?? FONT['?']).split(',');
      rows.forEach((row, ry) => {
        for (let rx = 0; rx < 5; rx++) {
          if (row[rx] === '1') this.rect(Math.round((cursor + rx * size) * SCALE), Math.round((y + ry * size) * SCALE), size * SCALE, size * SCALE, color);
        }
      });
      cursor += 6 * size;
    }
  }
  // Label kept inside the image, over a dark plate so that lines do not cross the letters.
  label(value, x, y, color, size = 1) {
    const width = this.textWidth(value, size), height = 7 * size;
    const left = Math.max(4, Math.min(SIZE - width - 4, x)), top = Math.max(34, Math.min(SIZE - height - 24, y));
    this.rect((left - 2) * SCALE, (top - 2) * SCALE, (width + 4) * SCALE, (height + 4) * SCALE, COLORS.background);
    this.text(value, left, top, color, size);
    return { left, top, width, height };
  }
  downsampled() {
    const out = Buffer.alloc(SIZE * SIZE * 3);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let sy = 0; sy < SCALE; sy++) for (let sx = 0; sx < SCALE; sx++) sum += this.pixels[((y * SCALE + sy) * CANVAS + x * SCALE + sx) * 3 + c];
      out[(y * SIZE + x) * 3 + c] = Math.round(sum / (SCALE * SCALE));
    }
    return out;
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function png(rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0); header.writeUInt32BE(SIZE, 4);
  header[8] = 8; header[9] = 2; // 8 bits per channel, RGB.
  const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) rgb.copy(raw, y * (SIZE * 3 + 1) + 1, y * SIZE * 3, (y + 1) * SIZE * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const coordinate = n => Number.isFinite(n) && Math.abs(n) < 1000000;
const NICE_STEPS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

// Null when the event has no coordinates: the message then goes out without a map.
export function mapData(event) {
  const d = event?.data;
  if (!d || !coordinate(d.x) || !coordinate(d.y) || !Array.isArray(d.players)) return null;
  const players = d.players.filter(p => coordinate(p.x) && coordinate(p.y));
  return players.length ? { d, players } : null;
}

export function renderMap(event) {
  const data = mapData(event);
  if (!data) return null;
  const { d, players } = data;
  const canvas = new Canvas();
  const center = {
    x: players.reduce((sum, p) => sum + p.x, 0) / players.length,
    y: players.reduce((sum, p) => sum + p.y, 0) / players.length,
  };
  const estimated = players.every(p => p.estimated);
  const reach = Math.max(50, ...players.map(p => Math.hypot(p.x - center.x, p.y - center.y)), Math.hypot(d.x - center.x, d.y - center.y)) * 1.25;
  const middle = SIZE / 2 + 6, radius = 212, ratio = radius / reach;
  const toScreen = (x, y) => ({ x: SIZE / 2 + (x - center.x) * ratio, y: middle + (y - center.y) * ratio });

  canvas.line(SIZE / 2, middle - radius, SIZE / 2, middle + radius, COLORS.axis);
  canvas.line(SIZE / 2 - radius, middle, SIZE / 2 + radius, middle, COLORS.axis);
  const step = NICE_STEPS.find(s => reach / s <= 4) ?? 5000;
  for (let tiles = step; tiles <= reach; tiles += step) canvas.ring(SIZE / 2, middle, tiles * ratio, COLORS.ring);
  const herd = toScreen(d.x, d.y);

  // Link from the group to the herd, with the distance in the middle.
  const distance = Math.round(Math.hypot(d.x - center.x, d.y - center.y));
  canvas.line(SIZE / 2, middle, herd.x, herd.y, COLORS.link, 1, 5);

  const count = Number.isFinite(d.count) ? d.count : 0;
  const size = Math.min(30, 9 + Math.sqrt(Math.max(0, count)) * 1.3);

  // Where the herd is heading. The route may leave the image, so its arrow is clipped.
  if (coordinate(d.destX) && coordinate(d.destY) && Math.hypot(d.destX - d.x, d.destY - d.y) > 2) {
    const length = Math.hypot(d.destX - d.x, d.destY - d.y);
    const ux = (d.destX - d.x) / length, uy = (d.destY - d.y) / length;
    const drawn = size + Math.max(30, Math.min(length * ratio, 90));
    const headX = herd.x + ux * drawn, headY = herd.y + uy * drawn;
    canvas.line(herd.x + ux * size, herd.y + uy * size, headX, headY, COLORS.route, 2);
    canvas.line(headX, headY, headX - ux * 12 - uy * 7, headY - uy * 12 + ux * 7, COLORS.route, 2);
    canvas.line(headX, headY, headX - ux * 12 + uy * 7, headY - uy * 12 - ux * 7, COLORS.route, 2);
    canvas.label('RUMO', headX + ux * 8 - 12, headY + uy * 8 - 3, COLORS.route);
  }

  if (estimated) {
    canvas.ring(herd.x, herd.y, size, COLORS.estimated, 2, 4);
    canvas.label('ESTIMADA', herd.x - 24, herd.y + size + 6, COLORS.estimated);
  } else {
    canvas.disc(herd.x, herd.y, size, COLORS.herd);
  }
  const amount = String(count);
  canvas.text(amount, herd.x - canvas.textWidth(amount, 1) / 2, herd.y - 3, estimated ? COLORS.estimated : COLORS.text);

  // Players on the same spot get stacked labels instead of unreadable overlapping text.
  const taken = [];
  for (const p of [...players].sort((a, b) => a.y - b.y).slice(0, 16)) {
    const spot = toScreen(p.x, p.y);
    canvas.disc(spot.x, spot.y, 5, COLORS.player);
    let y = spot.y - 3;
    while (taken.some(t => Math.abs(t.y - y) < 12 && Math.abs(t.x - spot.x) < 110)) y += 12;
    taken.push({ x: spot.x, y });
    canvas.label(fontText(p.name, 16), spot.x + 10, y, COLORS.player);
  }

  // Header, footer and compass letters last, so nothing covers them.
  const midX = (SIZE / 2 + herd.x) / 2, midY = (middle + herd.y) / 2;
  if (distance > 0) canvas.label(`${distance} TILES`, midX - 22, midY - 12, COLORS.label);
  for (const [letter, x, y] of [['N', SIZE / 2 - 3, middle - radius - 3], ['S', SIZE / 2 - 3, middle + radius - 4], ['L', SIZE / 2 + radius - 3, middle - 3], ['O', SIZE / 2 - radius - 3, middle - 3]]) {
    canvas.label(letter, x, y, COLORS.text);
  }
  canvas.rect(0, 0, CANVAS, 30 * SCALE, COLORS.band);
  canvas.rect(0, (SIZE - 20) * SCALE, CANVAS, 20 * SCALE, COLORS.band);
  const side = compass(d.x - center.x, d.y - center.y);
  const title = `HORDA DE ${count} ${side ? `A ${side}` : 'AQUI'}${estimated ? ' (ESTIMADA)' : ''}`;
  canvas.text(title, (SIZE - canvas.textWidth(title, 2)) / 2, 8, estimated ? COLORS.estimated : COLORS.text, 2);
  canvas.text(`HORDA ${Math.round(d.x)},${Math.round(d.y)}`, 8, SIZE - 14, COLORS.label);
  const scale = `ANEIS: ${step} TILES`;
  canvas.text(scale, SIZE - canvas.textWidth(scale, 1) - 8, SIZE - 14, COLORS.label);
  return png(canvas.downsampled());
}
