// PNG 角色卡：卡片 JSON 以 base64 存在 tEXt 块里（V2 的关键字是 chara，V3 是 ccv3）。

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class PngError extends Error {}

interface Chunk {
  type: string;
  /** 整块（长度 + 类型 + 数据 + CRC）在文件里的起止位置。 */
  start: number;
  end: number;
  data: Uint8Array;
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

function chunks(bytes: Uint8Array): Chunk[] {
  if (!isPng(bytes)) throw new PngError('不是 PNG 文件');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Chunk[] = [];
  let p = 8;
  while (p + 12 <= bytes.length) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const end = p + 12 + len;
    if (end > bytes.length) throw new PngError('PNG 文件不完整');
    out.push({ type, start: p, end, data: bytes.subarray(p + 8, p + 8 + len) });
    p = end;
    if (type === 'IEND') break;
  }
  return out;
}

/** 读出 tEXt / iTXt 文本块：关键字 → 文字。 */
export function pngTexts(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of chunks(bytes)) {
    if (c.type !== 'tEXt' && c.type !== 'iTXt') continue;
    const zero = c.data.indexOf(0);
    if (zero < 0) continue;
    const key = new TextDecoder('latin1').decode(c.data.subarray(0, zero));
    if (c.type === 'tEXt') {
      out.set(key, new TextDecoder('latin1').decode(c.data.subarray(zero + 1)));
    } else {
      // iTXt：关键字\0 压缩标志 压缩方法 语言\0 译名\0 文字（只支持未压缩）
      const compressed = c.data[zero + 1];
      if (compressed) continue;
      let q = zero + 3;
      q = c.data.indexOf(0, q) + 1; // 语言
      q = c.data.indexOf(0, q) + 1; // 译名
      if (q <= 0) continue;
      out.set(key, new TextDecoder().decode(c.data.subarray(q)));
    }
  }
  return out;
}

/** 去掉指定关键字的文本块（保存头像时去掉卡片数据，图片更小）。其余块原样保留。 */
export function stripPngTexts(bytes: Uint8Array, keys: readonly string[]): Uint8Array {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  for (const c of chunks(bytes)) {
    if (c.type === 'tEXt' || c.type === 'iTXt') {
      const zero = c.data.indexOf(0);
      const key = zero < 0 ? '' : new TextDecoder('latin1').decode(c.data.subarray(0, zero));
      if (keys.includes(key)) continue;
    }
    parts.push(bytes.subarray(c.start, c.end));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 从 PNG 里取出角色卡 JSON：优先 V3（ccv3），其次 V2（chara）。 */
export function cardFromPng(bytes: Uint8Array): unknown {
  const texts = pngTexts(bytes);
  const raw = texts.get('ccv3') ?? texts.get('chara');
  if (raw === undefined) throw new PngError('这张 PNG 里没有角色卡数据');
  const bin = Uint8Array.from(atob(raw.trim()), (ch) => ch.charCodeAt(0));
  try {
    return JSON.parse(new TextDecoder().decode(bin));
  } catch {
    throw new PngError('PNG 里的角色卡数据不是有效的 JSON');
  }
}
