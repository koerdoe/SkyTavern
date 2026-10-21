import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminPage } from './pages/AdminPage.tsx';
import { ChatPage } from './pages/ChatPage.tsx';
import { DocsPage } from './pages/DocsPage.tsx';
import { AppProvider } from './store.tsx';
import './styles.css';

const path = location.pathname.replace(/\/+$/, '');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {path === '/docs' || path.startsWith('/docs/') ? (
      // 文档页不需要加载资料库和会话
      <DocsPage />
    ) : (
      <AppProvider>{path === '/admin' ? <AdminPage /> : <ChatPage />}</AppProvider>
    )}
  </StrictMode>,
);
