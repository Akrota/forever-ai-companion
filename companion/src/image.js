// Minimal PNG and TGA decoders (no dependencies). Returns
// { width, height, channels, data } with 8-bit samples, top-down rows.
import zlib from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePNG(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('No es un PNG');
  let pos = 8;
  let width, height, bitDepth, colorType, interlace;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8) throw new Error(`PNG con profundidad ${bitDepth} no soportado`);
  if (interlace) throw new Error('PNG entrelazado no soportado');
  const channels = { 2: 3, 6: 4, 0: 1, 4: 2 }[colorType];
  if (!channels) throw new Error(`PNG con tipo de color ${colorType} no soportado`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= channels ? out[dst + x - channels] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= channels && y > 0 ? out[prev + x - channels] : 0;
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`Filtro PNG desconocido ${filter}`);
      }
      out[dst + x] = r & 0xff;
    }
  }
  return toRGB({ width, height, channels, data: out });
}

// Gray / gray+alpha -> RGB so callers can always read 3+ channels.
function toRGB(img) {
  if (img.channels >= 3) return img;
  const { width, height, channels, data } = img;
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const g = data[i * channels];
    out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = g;
  }
  return { width, height, channels: 3, data: out };
}

export function decodeTGA(buf) {
  const idLen = buf[0];
  const imageType = buf[2];
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const bpp = buf[16];
  const topDown = (buf[17] & 0x20) !== 0;
  if (![2, 10].includes(imageType)) throw new Error(`TGA tipo ${imageType} no soportado`);
  if (bpp !== 24 && bpp !== 32) throw new Error(`TGA de ${bpp} bits no soportado`);
  const px = bpp / 8;
  const pixels = Buffer.alloc(width * height * px);
  let pos = 18 + idLen;
  if (imageType === 2) {
    buf.copy(pixels, 0, pos, pos + pixels.length);
  } else {
    let i = 0;
    while (i < pixels.length) {
      const header = buf[pos++];
      const count = (header & 0x7f) + 1;
      if (header & 0x80) {
        for (let k = 0; k < count; k++) { buf.copy(pixels, i, pos, pos + px); i += px; }
        pos += px;
      } else {
        buf.copy(pixels, i, pos, pos + count * px);
        i += count * px;
        pos += count * px;
      }
    }
  }
  // BGR(A), usually bottom-up -> RGB, top-down
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const srcY = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const s = (srcY * width + x) * px;
      const d = (y * width + x) * 3;
      out[d] = pixels[s + 2];
      out[d + 1] = pixels[s + 1];
      out[d + 2] = pixels[s];
    }
  }
  return { width, height, channels: 3, data: out };
}

export function decodeImage(buf, filename = '') {
  if (buf.subarray(0, 8).equals(PNG_SIG)) return decodePNG(buf);
  if (/\.tga$/i.test(filename)) return decodeTGA(buf);
  throw new Error('Formato de captura no soportado (usa PNG o TGA)');
}
