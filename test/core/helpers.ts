import type { Entry, HistoryMessage, InsertPlacement, Section, VarLookup, VarValue } from '../../src/core/index.ts';

let seq = 0;

export function pos(section: Section, content: string, opts: Partial<Entry> & { depth?: number } = {}): Entry {
  const { depth, ...rest } = opts;
  return {
    id: `p-${++seq}`,
    source: 'preset',
    enabled: true,
    role: 'system',
    content,
    priority: 0,
    placement: depth === undefined ? { kind: 'position', section } : { kind: 'position', section, depth },
    ...rest,
  };
}

export function ins(pattern: string, template: string, opts: Partial<InsertPlacement> & Partial<Entry> = {}): Entry {
  const { flags, scope, pick, onMiss, ...rest } = opts;
  return {
    id: `p-${++seq}`,
    source: 'preset',
    enabled: true,
    role: 'system',
    content: template,
    priority: 0,
    placement: {
      kind: 'insert',
      pattern,
      ...(flags === undefined ? {} : { flags }),
      scope: scope ?? ['before', 'chat', 'after'],
      pick: pick ?? 'first',
      onMiss: onMiss ?? 'warn',
    },
    ...rest,
  };
}

export function mark(section: Section, opts: Partial<Entry> & { depth?: number } = {}): Entry {
  const { depth, ...rest } = opts;
  return {
    ...pos(section, '', rest),
    placement: depth === undefined ? { kind: 'cacheMark', section } : { kind: 'cacheMark', section, depth },
  };
}

/** 生成 n 条交替的正文：u0 a1 u2 … */
export function chat(n: number, text: (i: number) => string = (i) => `m${i}`): HistoryMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `h${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: text(i),
  }));
}

export const vars = (o: Record<string, VarValue> = {}): VarLookup => (name) => o[name];

export const contents = (ms: readonly { content: string }[]): string[] => ms.map((m) => m.content);
