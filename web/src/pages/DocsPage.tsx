// /docs：渲染仓库里的 docs/*.md。文档只写一份，这里只负责显示。

import { Marked } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import { docHref, slugger } from '../../../src/core/docs.ts';
import { api } from '../api.ts';
import { Icon } from '../ui.tsx';

interface DocSummary {
  name: string;
  title: string;
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function render(md: string): string {
  const slug = slugger();
  const marked = new Marked({
    gfm: true,
    walkTokens(token) {
      if (token.type === 'link') token.href = docHref(token.href);
    },
    renderer: {
      heading({ tokens, depth, text }) {
        const id = slug(text.replace(/`/g, ''));
        const inner = this.parser.parseInline(tokens);
        return `<h${depth} id="${escapeAttr(id)}"><a class="doc-anchor" href="#${escapeAttr(id)}" aria-hidden="true">#</a>${inner}</h${depth}>\n`;
      },
    },
  });
  return marked.parse(md, { async: false });
}

const pageName = (path: string) => {
  const m = /^\/docs\/([A-Za-z0-9-]+)\/?$/.exec(path);
  return m ? m[1]! : 'README';
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = (await res.json()) as T & { message?: string };
  if (!res.ok) throw new Error(data.message ?? `请求失败（${res.status}）`);
  return data;
}

export function DocsPage() {
  const [name, setName] = useState(() => pageName(location.pathname));
  const [list, setList] = useState<DocSummary[]>([]);
  const [md, setMd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const body = useRef<HTMLElement>(null);

  // 主题跟随账号设置
  useEffect(() => {
    api
      .settings()
      .then((s) => {
        const theme = s.ui.theme;
        if (theme === 'system') delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = theme;
      })
      .catch(() => {});
    fetchJson<{ docs: DocSummary[] }>('/api/docs')
      .then((r) => setList(r.docs))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setMd(null);
    setError(null);
    fetchJson<{ markdown: string }>(`/api/docs/${name}`)
      .then((r) => setMd(r.markdown))
      .catch((e: Error) => setError(e.message));
  }, [name]);

  const html = useMemo(() => (md === null ? '' : render(md)), [md]);

  useEffect(() => {
    const t = list.find((d) => d.name === name)?.title;
    document.title = t ? `${t} · SkyTavern 文档` : 'SkyTavern 文档';
  }, [list, name]);

  // 渲染完成后定位到锚点；外部链接新窗口打开
  useEffect(() => {
    if (!html || !body.current) return;
    for (const a of body.current.querySelectorAll<HTMLAnchorElement>('a[href^="http"]')) {
      a.target = '_blank';
      a.rel = 'noreferrer';
    }
    scrollToHash();
  }, [html]);

  // 站内跳转不刷新页面
  const go = (href: string) => {
    const url = new URL(href, location.href);
    history.pushState(null, '', url.pathname + url.hash);
    setNavOpen(false);
    const next = pageName(url.pathname);
    if (next !== name) setName(next);
    else scrollToHash();
  };

  useEffect(() => {
    const onPop = () => {
      setName(pageName(location.pathname));
      scrollToHash();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const onClick = (e: React.MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!a || !href || a.target === '_blank') return;
    if (href.startsWith('#') || href.startsWith('/docs')) {
      e.preventDefault();
      go(href.startsWith('#') ? location.pathname + href : href);
    }
  };

  return (
    <div className="docs" onClick={onClick}>
      <header className="topbar" style={{ height: 46 }}>
        <a className="btn ghost small" href="/">
          <Icon name="back" size={14} />
          返回对话
        </a>
        <strong>文档</strong>
        <span className="spacer" />
        <button className="btn ghost small mobile-only" onClick={() => setNavOpen((v) => !v)}>
          <Icon name="book" size={14} />
          目录
        </button>
      </header>
      <div className="docs-inner">
        <nav className={`docs-nav${navOpen ? ' open' : ''}`}>
          {list.map((d) => (
            <a key={d.name} href={d.name === 'README' ? '/docs' : `/docs/${d.name}`} className={d.name === name ? 'active' : ''}>
              {d.name === 'README' ? '概览' : d.title}
            </a>
          ))}
        </nav>
        <article className="doc-body" ref={body}>
          {error ? <div className="gen-error">{error}</div> : md === null ? <div className="empty">加载中…</div> : <div dangerouslySetInnerHTML={{ __html: html }} />}
        </article>
      </div>
    </div>
  );
}

function scrollToHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  requestAnimationFrame(() => {
    const el = id ? document.getElementById(id) : null;
    if (el) el.scrollIntoView();
    else document.querySelector('.docs')?.scrollTo(0, 0);
  });
}
