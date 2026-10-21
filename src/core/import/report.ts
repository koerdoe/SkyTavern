// 导入报告：哪些地方和酒馆不一样、哪些词条被停用以及原因。

export interface ImportReport {
  kind: 'character' | 'worldbook';
  name: string;
  /** 兼容差异（汇总成句子，不逐条重复）。 */
  notes: string[];
  /** 导入后停用的词条 / 正则及原因。原本就停用的不算。 */
  disabled: { name: string; reason: string }[];
  /** 没有导入的东西及原因。 */
  skipped: { name: string; reason: string }[];
}

export function newReport(kind: ImportReport['kind'], name: string): ImportReport {
  return { kind, name, notes: [], disabled: [], skipped: [] };
}

/** 同一类差异计数，最后汇总成一句话。 */
export class Tally {
  private readonly counts = new Map<string, number>();
  add(message: string): void {
    this.counts.set(message, (this.counts.get(message) ?? 0) + 1);
  }
  /** “{n}” 换成次数。 */
  flush(into: string[]): void {
    for (const [m, n] of this.counts) into.push(m.replace('{n}', String(n)));
    this.counts.clear();
  }
}
