import { OrchestrationError, PRIORITY_LIMIT, type Entry, type EntrySource } from './types.ts';

/** 拆分 `容器ID-词条ID`。容器ID 本身可以含 `-`，以最后一个为界。 */
export function parseEntryId(id: string): { container: string; local: number } {
  const cut = id.lastIndexOf('-');
  const local = Number(id.slice(cut + 1));
  if (cut <= 0 || !Number.isSafeInteger(local) || local < 0) {
    throw new Error(`词条 ID 格式应为 容器ID-整数：${id}`);
  }
  return { container: id.slice(0, cut), local };
}

/** 容器ID 按自然顺序比较：wb2 在 wb10 前面。 */
const compareContainers = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });

export function compareEntryIds(a: string, b: string): number {
  const pa = parseEntryId(a);
  const pb = parseEntryId(b);
  return compareContainers(pa.container, pb.container) || pa.local - pb.local;
}

/** 同一位置内：优先级降序，同优先级按 ID 升序。 */
export function compareEntries(a: Entry, b: Entry): number {
  return b.priority - a.priority || compareEntryIds(a.id, b.id);
}

// ---------- 撞车避让 ----------

/** 容器先后：预设 → 角色卡 → 用户自机 → 世界书（按容器ID）。靠前的容器保持原优先级。 */
const SOURCE_RANK: Record<EntrySource, number> = { preset: 0, character: 1, persona: 2, worldbook: 3 };

export interface Bump {
  entryId: string;
  from: number;
  to: number;
}

/** 相互竞争同一组优先级的范围：同分区（正文还要同深度）；插入法单独一组。 */
function slotKey(e: Entry): string {
  const p = e.placement;
  if (p.kind === 'insert') return 'insert';
  return p.section === 'chat' ? `chat@${p.depth ?? 0}` : p.section;
}

/**
 * 不同容器的词条在同一位置撞上同一优先级时，靠前容器的保持不动，
 * 靠后容器的 +1，直到遇到空位或自己容器占的位置为止。同一容器内允许同优先级（按 ID 排）。
 * 结果只影响本次组装，不写回原词条；目的是让显示与实际顺序一致。
 */
export function resolveCollisions(entries: readonly Entry[]): { effective: Map<string, number>; bumped: Bump[] } {
  const containerOf = (e: Entry): string => `${e.source}:${parseEntryId(e.id).container}`;
  const ordered = [...entries].sort((a, b) => {
    const ca = parseEntryId(a.id);
    const cb = parseEntryId(b.id);
    return SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || compareContainers(ca.container, cb.container) || ca.local - cb.local;
  });

  const owners = new Map<string, Map<number, string>>();
  const effective = new Map<string, number>();
  const bumped: Bump[] = [];
  for (const e of ordered) {
    const key = slotKey(e);
    const owner = containerOf(e);
    let taken = owners.get(key);
    if (!taken) owners.set(key, (taken = new Map()));
    let p = e.priority;
    for (let o = taken.get(p); o !== undefined && o !== owner; o = taken.get(p)) p++;
    if (!taken.has(p)) taken.set(p, owner);
    if (p !== e.priority) {
      if (e.source !== 'preset' && Math.abs(p) > PRIORITY_LIMIT) {
        throw new OrchestrationError('bad-priority', `避让撞车后优先级 ${p} 超出 ±${PRIORITY_LIMIT}`, e.id);
      }
      bumped.push({ entryId: e.id, from: e.priority, to: p });
    }
    effective.set(e.id, p);
  }
  return { effective, bumped };
}
