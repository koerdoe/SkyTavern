// 附件在请求体里的写法。
//
// 组装请求体时附件先写成占位符（预览、Debug、最近一次请求里看到的就是它们，不会把几 MB 的 base64 发给浏览器），
// 真正发送前再换成文件内容：
//   sky-attachment:<id>       → base64
//   sky-attachment-url:<id>   → data:<mime>;base64,…
//   sky-attachment-text:<id>  → 文件的文字内容（UTF-8）

import type { AttachmentRef } from '../../core/types.ts';

export const placeholder = {
  base64: (a: AttachmentRef) => `sky-attachment:${a.id}`,
  dataUrl: (a: AttachmentRef) => `sky-attachment-url:${a.id}`,
  text: (a: AttachmentRef) => `sky-attachment-text:${a.id}`,
};

const PATTERN = /^sky-attachment(-url|-text)?:([A-Za-z0-9]+)$/;

export const isImage = (a: AttachmentRef): boolean => a.mime.startsWith('image/');
export const isText = (a: AttachmentRef): boolean => a.mime.startsWith('text/') || ['application/json', 'application/xml'].includes(a.mime);

export type AttachmentLoader = (id: string) => { mime: string; data: Uint8Array } | undefined;

export class AttachmentMissing extends Error {}

/** 把请求体里的占位符换成文件内容（返回新的对象，不改原来的）。 */
export function resolveAttachments(body: unknown, load: AttachmentLoader): unknown {
  const cache = new Map<string, { mime: string; data: Uint8Array }>();
  const get = (id: string) => {
    let f = cache.get(id);
    if (!f) {
      f = load(id);
      if (!f) throw new AttachmentMissing(`附件 ${id} 不存在（可能已被清理）`);
      cache.set(id, f);
    }
    return f;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = PATTERN.exec(v);
      if (!m) return v;
      const f = get(m[2]!);
      const b64 = Buffer.from(f.data).toString('base64');
      if (m[1] === '-url') return `data:${f.mime};base64,${b64}`;
      if (m[1] === '-text') return new TextDecoder().decode(f.data);
      return b64;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(body);
}
