// Decodes the cell grid the addon draws before taking a screenshot.
// Layout documented in addon/AzerothIA/Uplink.lua.

export const MAGIC = 'AZIA';
export const VERSION = 1;

export function adler32(buf) {
  let a = 1, b = 0;
  for (const byte of buf) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return (b * 65536 + a) >>> 0;
}

export function symbolsToBytes(symbols) {
  const out = [];
  for (let i = 0; i + 3 < symbols.length; i += 4) {
    const n = (symbols[i] << 18) | (symbols[i + 1] << 12) | (symbols[i + 2] << 6) | symbols[i + 3];
    out.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  return Buffer.from(out);
}

// LZW with codes growing from 9 to 16 bits (see addon/AzerothIA/Uplink.lua).
export function lzwDecompress(data, outLength) {
  const dict = [];
  for (let i = 0; i < 256; i++) dict.push(Buffer.from([i]));
  const out = [];
  let produced = 0;
  let bitPos = 0;
  const totalBits = data.length * 8;
  let encNext = 256; // the encoder's next free code when it emitted this one
  let prev = null;
  while (produced < outLength) {
    let width = 9;
    while (width < 16 && encNext > 2 ** width) width++;
    if (bitPos + width > totalBits) throw new Error('Datos comprimidos truncados');
    let code = 0;
    for (let i = 0; i < width; i++, bitPos++) {
      code = code * 2 + ((data[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
    }
    let entry;
    if (code < dict.length) entry = dict[code];
    else if (code === dict.length && prev) entry = Buffer.concat([prev, prev.subarray(0, 1)]);
    else throw new Error('Código LZW inválido');
    out.push(entry);
    produced += entry.length;
    if (prev && dict.length < 65536) dict.push(Buffer.concat([prev, entry.subarray(0, 1)]));
    prev = entry;
    if (encNext < 65536) encNext++;
  }
  return Buffer.concat(out).subarray(0, outLength);
}

// Returns the payload Buffer, or throws if the frame is corrupt.
export function parseFrame(bytes) {
  if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== MAGIC) throw new Error('Sin marca AZIA');
  const u24 = (i) => (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
  let payload, end;
  if (bytes[4] === 1) {
    const len = u24(5);
    end = 8 + len;
    if (end + 4 > bytes.length) throw new Error('Longitud inválida');
    payload = bytes.subarray(8, end);
  } else if (bytes[4] === 2) {
    const compLen = u24(5);
    const len = u24(8);
    end = 11 + compLen;
    if (end + 4 > bytes.length) throw new Error('Longitud inválida');
    payload = lzwDecompress(bytes.subarray(11, end), len);
  } else {
    throw new Error(`Versión de protocolo ${bytes[4]} desconocida`);
  }
  if (adler32(payload) !== bytes.readUInt32BE(end)) throw new Error('Checksum incorrecto');
  return payload;
}

function makeReader(img) {
  const { width, height, channels, data } = img;
  const pixel = (x, y) => {
    const i = (y * width + x) * channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const lum = (x, y) => {
    const [r, g, b] = pixel(x, y);
    return (r + g + b) / 3;
  };
  return { width, height, pixel, lum };
}

// Positions where a white/black alternation flips, along a line.
function transitions(sample, limit, guess, threshold) {
  const out = [];
  let state = sample(0) >= threshold;
  let last = 0;
  // Small cells may render 1 px narrower or wider than nominal.
  const lo = Math.min(guess * 0.5, guess - 1.5);
  const hi = Math.max(guess * 1.5, guess + 1.5);
  for (let i = 1; i < limit; i++) {
    const s = sample(i) >= threshold;
    if (s !== state) {
      const gap = i - last;
      if (gap < lo || gap > hi) break;
      out.push(i);
      last = i;
      state = s;
    } else if (i - last > hi) {
      break;
    }
  }
  return out;
}

function pitchFrom(bounds, count) {
  const k = Math.min(bounds.length, count);
  return k > 0 ? bounds[k - 1] / k : null;
}

// Returns the payload Buffer if the image contains an AzerothIA grid,
// null if it does not look like one, and throws if it does but is corrupt.
export function decodeGrid(img) {
  const rd = makeReader(img);
  const { width, height } = rd;
  if (width < 40 || height < 9) return null;
  // The rulers' "white" is the brightest level the addon uses (it may be a
  // dark gray); black/white are told apart relative to it.
  const white = rd.lum(1, 1);
  if (white < 50) return null;
  const threshold = white / 2;

  // First guess of the cell size: first dark pixel on row 0.
  let x = 1;
  while (x < Math.min(width, 64) && rd.lum(x, 1) >= threshold) x++;
  if (x < 2 || x >= 64) return null;
  const guess = x;

  const midY = Math.floor(guess / 2);
  const hBounds = transitions((i) => rd.lum(i, midY), width, guess, threshold);
  if (hBounds.length < 8) return null;
  let pX = pitchFrom(hBounds, hBounds.length);
  let pY = pX;

  const cellRGB = (c, r) => {
    const cx = Math.round((c + 0.5) * pX - 0.5);
    const cy = Math.round((r + 0.5) * pY - 0.5);
    // Average a 3x3 block for big cells; small cells use their center pixel.
    const k = pX >= 5 && pY >= 5 ? 1 : 0;
    const acc = [0, 0, 0];
    let n = 0;
    for (let dy = -k; dy <= k; dy++) {
      for (let dx = -k; dx <= k; dx++) {
        const px = Math.min(width - 1, Math.max(0, cx + dx));
        const py = Math.min(height - 1, Math.max(0, cy + dy));
        const p = rd.pixel(px, py);
        acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2];
        n++;
      }
    }
    return acc.map((v) => v / n);
  };

  let cal;
  const calibrate = () => {
    cal = [[], [], []];
    for (let level = 0; level < 4; level++) {
      const rgb = cellRGB(1 + level, 1);
      for (let ch = 0; ch < 3; ch++) cal[ch][level] = rgb[ch];
    }
    for (let ch = 0; ch < 3; ch++) {
      const c = cal[ch];
      if (!(c[0] < c[1] && c[1] < c[2] && c[2] < c[3]) || c[3] - c[0] < white * 0.5) return false;
    }
    return true;
  };
  const quantize = (v, ch) => {
    const c = cal[ch];
    let best = 0;
    for (let l = 1; l < 4; l++) if (Math.abs(v - c[l]) < Math.abs(v - c[best])) best = l;
    return best;
  };
  const symbol = (c, r) => {
    const rgb = cellRGB(c, r);
    return quantize(rgb[0], 0) * 16 + quantize(rgb[1], 1) * 4 + quantize(rgb[2], 2);
  };

  // From here on the black/white ruler clearly says "this is an AzerothIA
  // capture": failures are reported (something covered it) instead of the
  // screenshot being silently treated as a normal one.
  const covered = () => new GridUnreadableError(
    'La captura con la pregunta no se pudo leer: algo tapaba la esquina superior izquierda de la pantalla.');
  if (!calibrate()) throw covered();
  const W = symbol(5, 1) * 64 + symbol(6, 1);
  const H = symbol(7, 1) * 64 + symbol(8, 1);
  if (W < 12 || H < 3 || (W - 0.5) * pX > width || (H - 0.5) * pY > height) throw covered();

  // Refine the pitch using every internal boundary of row 0 and column 0.
  pX = pitchFrom(hBounds, W - 1) ?? pX;
  const vBounds = transitions((i) => rd.lum(Math.floor(pX / 2), i), height, pX, threshold);
  if (vBounds.length >= 2) pY = pitchFrom(vBounds, H - 1);
  if (!calibrate()) throw covered();

  const symbols = [];
  for (let r = 2; r < H; r++) {
    for (let c = 1; c < W; c++) symbols.push(symbol(c, r));
  }
  const bytes = symbolsToBytes(symbols);
  try {
    return parseFrame(bytes);
  } catch {
    throw covered();
  }
}

export class GridUnreadableError extends Error {}
