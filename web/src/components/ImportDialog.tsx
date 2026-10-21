// 导入酒馆角色卡（PNG / JSON）和世界书 JSON。可以一次选多个文件；导入后列出每个的报告：
// 和酒馆不一样的地方、被停用的词条和原因。

import { useRef, useState } from 'react';
import { api, errorText, type ImportedItem } from '../api.ts';
import { useStore } from '../store.tsx';
import { HelpLink, Icon, Modal } from '../ui.tsx';

type Result = { file: string; items: ImportedItem[] } | { file: string; error: string };

const MAX_FILE = 24 * 1024 * 1024;

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('读取失败'));
    r.readAsDataURL(file);
  });
}

export function ImportButton() {
  const store = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);

  const run = async (files: File[]) => {
    setBusy(true);
    const out: Result[] = [];
    for (const f of files) {
      try {
        if (f.size > MAX_FILE) throw new Error('文件太大（上限 24 MB）');
        out.push({ file: f.name, items: (await api.importFile(f.name, await toBase64(f))).items });
      } catch (e) {
        out.push({ file: f.name, error: errorText(e) });
      }
    }
    await Promise.all([store.reloadList('character'), store.reloadList('worldbook')]);
    setBusy(false);
    setResults(out);
  };

  return (
    <>
      <button className="btn icon" title="导入酒馆角色卡（PNG / JSON）或世界书 JSON" disabled={busy} onClick={() => input.current?.click()}>
        <Icon name="download" size={14} />
      </button>
      <input
        ref={input}
        type="file"
        accept=".png,.json,image/png,application/json"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) void run(files);
        }}
      />
      {results && <ImportReportDialog results={results} onClose={() => setResults(null)} />}
    </>
  );
}

function ImportReportDialog({ results, onClose }: { results: Result[]; onClose: () => void }) {
  const store = useStore();
  const ok = results.flatMap((r) => ('items' in r ? r.items : []));
  return (
    <Modal title="导入结果" onClose={onClose} actions={<HelpLink to="import" title="导入说明" />}>
      <div className="modal-body import-report">
        <p className="muted" style={{ margin: 0 }}>
          导入了 {ok.filter((i) => i.kind === 'character').length} 张角色卡、{ok.filter((i) => i.kind === 'worldbook').length} 本世界书。
          {ok.some((i) => i.report.disabled.length) && ' 有些词条转换不了，已停用，修好后再启用。'}
        </p>
        {results.map((r, k) => (
          <section key={k} className="card">
            <div className="row">
              <strong>{r.file}</strong>
            </div>
            {'error' in r ? (
              <div className="gen-error">{r.error}</div>
            ) : (
              r.items.map((it) => (
                <div key={it.id} className="import-item">
                  <div className="row">
                    <span className="chip plain">{it.kind === 'character' ? '角色卡' : '世界书'}</span>
                    <strong>{it.name}</strong>
                    <span className="faint mono">{it.id}</span>
                    <span className="spacer" />
                    {it.kind === 'character' && (
                      <button
                        className="btn small"
                        onClick={() => {
                          void store.selectCharacter(it.id);
                          onClose();
                        }}
                      >
                        打开
                      </button>
                    )}
                  </div>
                  {it.report.notes.length > 0 && (
                    <ul className="import-notes">
                      {it.report.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  )}
                  {it.report.disabled.length > 0 && (
                    <div className="import-disabled">
                      <div className="faint" style={{ fontSize: 12 }}>
                        已停用 {it.report.disabled.length} 项：
                      </div>
                      <ul>
                        {it.report.disabled.map((d, i) => (
                          <li key={i}>
                            <strong>{d.name}</strong>：{d.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))
            )}
          </section>
        ))}
      </div>
    </Modal>
  );
}
