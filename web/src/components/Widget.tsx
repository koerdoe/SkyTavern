// HTML 组件：在沙箱 iframe 里运行（没有同源权限，不能加载外部脚本，只能加载外部图片）。
// 通过宿主接口读取这一层的变量和最近的聊天；修改先暂存在组件里，commit 时才写成这一层的变量操作。
// 组件还可以附上一条“附加消息”（例如本轮的交易记录），显示在消息末尾，下一轮作为 user 消息发给模型。

import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useStore } from '../store.tsx';

/** 注入到组件里的宿主接口：window.sky。 */
const BRIDGE = `(() => {
  let seq = 0;
  const waits = new Map();
  const staged = [];
  let note = '';
  const call = (type, payload) => new Promise((resolve, reject) => {
    const id = ++seq;
    waits.set(id, { resolve, reject });
    parent.postMessage({ __sky: true, id, type, payload }, '*');
  });
  addEventListener('message', (e) => {
    const d = e.data;
    if (!d || !d.__sky || !waits.has(d.id)) return;
    const w = waits.get(d.id);
    waits.delete(d.id);
    d.error ? w.reject(new Error(d.error)) : w.resolve(d.result);
  });
  window.sky = {
    /** 这一层执行完之后的全部变量（不含尚未提交的暂存修改）。 */
    vars: () => call('vars'),
    /** 到这一层为止最近 n 条消息。 */
    chat: (n = 10) => call('chat', { n }),
    set: (name, value) => { staged.push({ name, op: '=', value }); },
    add: (name, n) => { staged.push({ name, op: '+=', value: n }); },
    sub: (name, n) => { staged.push({ name, op: '-=', value: n }); },
    /** 暂存一条附加消息（再次调用会替换），commit 时和变量修改一起写入。 */
    note: (text) => { note = String(text ?? ''); },
    staged: () => staged.slice(),
    discard: () => { staged.length = 0; note = ''; },
    /** 把暂存的修改写成这一层的变量操作（连同附加消息），返回写入的操作条数。 */
    commit: async () => {
      const ops = staged.splice(0);
      const text = note.trim();
      note = '';
      if (ops.length || text) await call('commit', text ? { ops, note: text } : { ops });
      return ops.length;
    },
  };
  // 按 body 的实际高度汇报（内容变矮时也能缩回去）
  const report = () => document.body && parent.postMessage({ __sky: true, type: 'height', payload: Math.ceil(document.body.getBoundingClientRect().height) }, '*');
  addEventListener('DOMContentLoaded', () => new ResizeObserver(report).observe(document.body));
  addEventListener('load', report);
})();`;

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src * data: blob:; font-src data:; media-src * data: blob:";

function srcdoc(html: string): string {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const base = `:root{color-scheme:${v('color-scheme') || 'light'};--text:${v('--text')};--text-2:${v('--text-2')};--accent:${v('--accent')};--border:${v('--border')};--surface:${v('--surface')};--surface-2:${v('--surface-2')}}
html,body{margin:0;background:transparent;color:var(--text);font:14px/1.6 ${v('--font-ui') || 'system-ui'}}
body{display:flow-root}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${base}</style><script>${BRIDGE}</script></head><body>${html}</body></html>`;
}

export function Widget({ html, sessionId, messageId }: { html: string; sessionId: string; messageId: string }) {
  const store = useStore();
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);
  const [doc] = useState(() => srcdoc(html));

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const frame = ref.current;
      // 只理会来自这个组件的消息
      if (!frame || e.source !== frame.contentWindow) return;
      const d = e.data as { __sky?: boolean; id?: number; type?: string; payload?: unknown };
      if (!d?.__sky) return;
      if (d.type === 'height') {
        setHeight(Math.max(24, Math.min(2000, Number(d.payload) || 0)));
        return;
      }
      const reply = (result: unknown, error?: string) => frame.contentWindow?.postMessage({ __sky: true, id: d.id, result, ...(error ? { error } : {}) }, '*');
      try {
        if (d.type === 'vars') {
          const report = await api.vars(sessionId);
          reply(report.layers.find((l) => l.messageId === messageId)?.state ?? report.final);
        } else if (d.type === 'chat') {
          const n = Math.max(1, Math.min(50, Number((d.payload as { n?: number })?.n) || 10));
          const layers = store.session?.layers ?? [];
          const upto = layers.findIndex((l) => l.id === messageId);
          reply(layers.slice(0, upto < 0 ? layers.length : upto + 1).slice(-n).map((l) => ({ role: l.role, content: l.content })));
        } else if (d.type === 'commit') {
          const { ops, note } = (d.payload ?? {}) as { ops?: unknown; note?: unknown };
          await api.op(sessionId, { op: 'addVarOps', messageId, ops: ops as never, ...(typeof note === 'string' && note ? { note } : {}) });
          await store.reloadSession();
          reply(true);
        } else {
          reply(null, `未知的调用：${d.type}`);
        }
      } catch (err) {
        reply(null, (err as Error).message);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [sessionId, messageId, store]);

  return <iframe ref={ref} className="widget" title="组件" sandbox="allow-scripts" srcDoc={doc} style={{ height }} />;
}
