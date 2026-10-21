// 请求预览：实际发送的消息、每条消息的来源、缓存断点、插入痕迹；可切换到协议请求体（只读）。

import { useEffect, useRef, useState } from 'react';
import type { AssembledMessage } from '../../../src/core/types.ts';
import type { PreviewView as Preview } from '../../../src/core/views.ts';
import { entryTitle, KIND_LABEL, type EntryItem } from '../entries.ts';
import { useStore } from '../store.tsx';
import { fileSize } from './Attachments.tsx';
import { calibrationText, tokenizerTitle } from '../tokens.ts';
import { Icon } from '../ui.tsx';

const SECTION_NAME = { system: '系统提示', before: '正文前', chat: '正文', after: '正文后' } as const;

export function PreviewView({ data, title = '请求预览', onClose, entryIndex }: { data: Preview | null; title?: string; onClose?: () => void; entryIndex?: Map<string, EntryItem> }) {
  const { focusMessage, previewError } = useStore();
  const [showBody, setShowBody] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusMessage === null) return;
    listRef.current?.querySelector(`[data-index="${focusMessage}"]`)?.scrollIntoView({ block: 'center' });
  }, [focusMessage, data]);

  if (!data) {
    return <div className="chat-empty">{previewError ? <div className="gen-error">{previewError.body.message}</div> : '正在组装…'}</div>;
  }

  const marks = new Set(data.cacheBreakpoints);
  return (
    <>
      <div className="preview-head">
        <strong>{title}</strong>
        <span className="chip plain">{data.messages.length} 条消息</span>
        <span className="chip plain" title={tokenizerTitle(data.tokenizer)}>
          约 {data.tokens.toLocaleString()} token
        </span>
        {data.tokenizer && (
          <span className={`chip ${data.tokenizer.error ? 'warn' : data.tokenizer.samples > 0 ? 'ok' : 'plain'}`} title={tokenizerTitle(data.tokenizer)}>
            {data.tokenizer.error ? '分词器未加载' : calibrationText(data.tokenizer).replace(/（.*）$/, '')}
          </span>
        )}
        <span className="chip ok">{data.cacheBreakpoints.length} 个缓存断点</span>
        {data.protocol ? <span className="chip accent">{data.protocol}</span> : <span className="chip warn">未选择模型</span>}
        {data.bumped.length > 0 && (
          <span className="chip warn" title={data.bumped.map((b) => `${b.entryId}: ${b.from} → ${b.to}`).join('\n')}>
            {data.bumped.length} 个词条撞车避让
          </span>
        )}
        <span className="spacer" />
        <div className="tabs" role="tablist">
          <button className="tab" role="tab" aria-selected={!showBody} onClick={() => setShowBody(false)}>
            消息
          </button>
          <button className="tab" role="tab" aria-selected={showBody} onClick={() => setShowBody(true)} disabled={!data.body}>
            请求体
          </button>
        </div>
        {onClose && (
          <button className="btn small" onClick={onClose}>
            <Icon name="chat" size={14} />
            回到对话
          </button>
        )}
      </div>
      <div className="chat-scroll">
        {showBody && data.body ? (
          <div className="preview-list">
            <p className="muted" style={{ margin: 0 }}>
              只读。密钥不在请求体里。要修改后发送请到 Debug 页。
            </p>
            <pre className="json-view">{JSON.stringify(data.body, null, 2)}</pre>
          </div>
        ) : (
          <div className="preview-list" ref={listRef}>
            {data.warnings.map((w) => (
              <div key={w.entryId} className="chip warn" style={{ height: 'auto', padding: '5px 8px', whiteSpace: 'normal' }}>
                {w.entryId}：{w.message}
              </div>
            ))}
            {data.messages.map((m, i) => (
              <div key={i}>
                <PreviewMessage m={m} index={i} focused={focusMessage === i} entryIndex={entryIndex} />
                {marks.has(i) && <div className="cache-line" style={{ marginTop: 8 }}>缓存复用到这里</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function PreviewMessage({ m, index, focused, entryIndex }: { m: AssembledMessage; index: number; focused: boolean; entryIndex: Map<string, EntryItem> | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const item = m.origin.kind === 'entry' ? entryIndex?.get(m.origin.entryId) : undefined;
  const origin =
    m.origin.kind === 'history'
      ? '聊天记录'
      : m.origin.kind === 'note'
        ? '附加消息（挂在上一条消息上）'
        : item
        ? `${KIND_LABEL[item.kind]}${item.kind === 'worldbook' ? `·${item.containerName}` : ''} · ${entryTitle(item.entry)}`
          : m.origin.entryId;
  return (
    <div className={`pmsg${focused ? ' focused' : ''}`} data-index={index}>
      <div className="pmsg-head">
        <span className="mono faint">#{index + 1}</span>
        <span className={`chip sec-${m.section}`}>{SECTION_NAME[m.section]}</span>
        <span className="chip plain">{m.role}</span>
        <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {origin}
        </span>
        <span className="spacer" />
        {m.insertedBy.length > 0 && (
          <span className="chip sec-insert" title={m.insertedBy.join('、')}>
            被插入 ×{m.insertedBy.length}
          </span>
        )}
        {m.protected && <span className="chip plain">受保护</span>}
        {m.volatile && <span className="chip plain" title="每轮可能变化，缓存不会越过它">易变</span>}
        <button className="btn ghost small" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : '展开'}
        </button>
      </div>
      {m.attachments && m.attachments.length > 0 && (
        <div className="pmsg-attachments">
          {m.attachments.map((a) => (
            <span key={a.id} className="chip plain" title={`${a.mime}，发送时按原文件封装`}>
              附件：{a.name}（{fileSize(a.size)}）
            </span>
          ))}
        </div>
      )}
      <pre className={`pmsg-body${expanded ? ' expanded' : ''}`}>{m.content}</pre>
    </div>
  );
}
