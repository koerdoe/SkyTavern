// 测试用：拼一个最小的 PNG。

/** 拼一个最小的 PNG：签名 + IHDR + 若干 tEXt + IEND（CRC 不校验，填 0）。 */
export function fakePng(texts: Record<string, string>): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    return out;
  };
  const latin1 = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', new Uint8Array(13)),
    ...Object.entries(texts).map(([k, v]) => chunk('tEXt', latin1(`${k}\0${v}`))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}
