// 酒馆正则（角色卡 extensions.regex_scripts）→ 我们的正则脚本。
//
//   作用范围 placement：1 用户输入、2 AI 回复；其他（世界书、推理、斜杠命令）不支持。
//   markdownOnly → 运行时 · 只作用于显示；promptOnly → 运行时 · 只作用于请求；两者都勾 → 显示和请求；
//   都不勾 → 返回时（改存下来的正文）。
//   替换文字里的 {{match}} → $&。
// 转不了的照样导入但停用，写明原因；顺序按原数组，越靠前优先级越高。

import { validateScript, ScriptError, type RegexScript } from '../scripts.ts';
import type { ScriptDraft } from '../library.ts';
import { convertMacros, macroReasons, noteMacros, type MacroWhere } from './macros.ts';
import type { ImportReport } from './report.ts';
import { Tally } from './report.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function convertRegexScripts(raw: unknown, report: ImportReport): ScriptDraft[] {
  if (!Array.isArray(raw)) return [];
  const tally = new Tally();
  const out: ScriptDraft[] = [];
  raw.forEach((r, i) => {
    if (!isObj(r)) return;
    const name = String(r.scriptName ?? '').trim() || `正则 ${i + 1}`;
    const reasons: string[] = [];

    // /pattern/flags 或者整串就是正则
    const find = String(r.findRegex ?? '');
    const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(find);
    let pattern = m ? m[1]! : find;
    let flags = m ? m[2]! : 'g';
    const dropped = flags.replace(/[gimsu]/g, '');
    if (dropped) {
      flags = flags.replace(/[^gimsu]/g, '');
      tally.add(`{n} 条正则用了我们不支持的标志（${dropped}），已去掉`);
    }
    flags = [...new Set(flags)].join('');
    if (!pattern) reasons.push('没有正则');

    const placement = Array.isArray(r.placement) ? r.placement.map(Number) : [];
    const roles = [...(placement.includes(1) ? ['user' as const] : []), ...(placement.includes(2) ? ['assistant' as const] : [])];
    if (roles.length === 0) reasons.push('只作用于世界书、推理或斜杠命令，我们不支持');
    if (placement.some((p) => p !== 1 && p !== 2)) tally.add('{n} 条正则的部分作用范围（世界书 / 推理 / 斜杠命令）已忽略');

    const md = r.markdownOnly === true;
    const prompt = r.promptOnly === true;
    const stage: RegexScript['stage'] = md || prompt ? 'runtime' : 'receive';
    const target: RegexScript['target'] = md && prompt ? 'both' : md ? 'display' : prompt ? 'request' : 'both';
    let replacement = String(r.replaceString ?? '').replace(/\{\{match\}\}/gi, '$$&');
    // 宏能不能转要看这条正则在哪一步执行
    const where: MacroWhere = stage === 'receive' ? 'receive' : target === 'request' ? 'request' : 'display';
    const macro = convertMacros(replacement, where);
    replacement = macro.text;
    reasons.push(...macroReasons(macro, where).map((x) => `替换文字里${x}`));
    noteMacros(report.notes, macro, where);
    if (Array.isArray(r.trimStrings) && r.trimStrings.some((t) => typeof t === 'string' && t !== '')) tally.add('{n} 条正则设了“修剪字符串”，已忽略');
    if (typeof r.substituteRegex === 'number' && r.substituteRegex !== 0) reasons.push('正则里替换宏（substituteRegex）我们不支持');
    if (r.minDepth != null || r.maxDepth != null) tally.add('{n} 条正则限制了作用深度，已忽略（作用于全部消息）');

    const draft: ScriptDraft = {
      name,
      enabled: r.disabled !== true,
      stage,
      target,
      roles: roles.length ? roles : ['assistant'],
      action: 'replace',
      latestOnly: false,
      pattern,
      flags,
      replacement,
      priority: raw.length - i,
    };
    if (reasons.length === 0) {
      try {
        validateScript({ ...draft, id: 'import' });
      } catch (e) {
        if (!(e instanceof ScriptError)) throw e;
        reasons.push(e.detail);
      }
    }
    if (reasons.length > 0) {
      if (draft.enabled) report.disabled.push({ name: `正则：${name}`, reason: reasons.join('；') });
      draft.enabled = false;
      if (!pattern) draft.pattern = '(?!)';
    }
    out.push(draft);
  });
  if (out.length) report.notes.push(`导入了 ${out.length} 条正则：酒馆“仅格式显示”对应运行时显示，“仅格式提示词”对应运行时请求，都不勾的对应返回时（改存下来的正文）`);
  tally.flush(report.notes);
  return out;
}
