// 收集一次生成需要的全部资料：预设、模型、角色卡、用户自机、世界书、变量。

import type { Character, ModelConfig, Persona, Preset } from '../../core/library.ts';
import type { RegexScript } from '../../core/scripts.ts';
import type { Entry, VarValue } from '../../core/types.ts';
import { parseInitialVars, type VarState } from '../../core/vars.ts';
import type { LibraryStore } from '../library/store.ts';

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextError';
  }
}

export interface GenContext {
  preset: Preset;
  /** 预览不需要模型；生成时由调用方检查。 */
  model: ModelConfig | null;
  character: Character;
  persona: Persona | null;
  entries: Entry[];
  /** 系统保留变量（char、user、$time…）；会话变量由重放得到，调用方合并，保留名优先。 */
  reserved: Record<string, VarValue>;
  /** 预设的正则脚本在前，角色卡的在后（同优先级时按此顺序执行）。 */
  scripts: RegexScript[];
  /** 初始变量：预设的，再由角色卡覆盖。 */
  initialVars: VarState;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 系统保留变量。会话变量（第 5 步）以后合并进来，保留名优先。 */
export function reservedVars(character: Character, persona: Persona | null, now: Date): Record<string, VarValue> {
  return {
    char: character.name,
    user: persona?.name ?? '用户',
    $date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    $time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    $weekday: `星期${WEEKDAYS[now.getDay()]}`,
    // 召回结果：生成时按需填入（见召回服务），其他时候为空文字
    $recall: '',
    // 最近的消息：生成时按聊天记录填入
    $lastMessage: '',
    $lastUserMessage: '',
    $lastCharMessage: '',
  };
}

export function loadContext(library: LibraryStore, user: string, characterId: string, now: Date): GenContext {
  const settings = library.settings(user);
  if (!settings.presetId) throw new ContextError('还没有选择预设');
  const preset = library.get(user, 'preset', settings.presetId);
  const model = settings.modelId ? library.get(user, 'model', settings.modelId) : null;
  if (model?.use === 'embedding') throw new ContextError(`“${model.name}”是嵌入模型，只能用于召回，不能用来对话`);
  const character = library.get(user, 'character', characterId);
  const persona = settings.personaId ? library.get(user, 'persona', settings.personaId) : null;
  const worldbooks = library.activeWorldbookIds(user, character).map((id) => library.get(user, 'worldbook', id));

  const entries = [...preset.entries, ...character.entries, ...(persona?.entries ?? []), ...worldbooks.flatMap((w) => w.entries)];
  return {
    preset,
    model,
    character,
    persona,
    entries,
    reserved: reservedVars(character, persona, now),
    scripts: [...preset.scripts, ...character.scripts],
    initialVars: { ...parseInitialVars(preset.initialVars).state, ...parseInitialVars(character.initialVars).state },
  };
}
