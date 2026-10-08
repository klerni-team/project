import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import '@astryxdesign/core/reset.css';
import './index.css';
import {Theme} from '@astryxdesign/core/theme';
import {matchaTheme} from './themes/matcha/matchaTheme';
import {StoreProvider} from './lib/store.tsx';
import {ChatProvider} from './lib/chat.tsx';
import App from './App.tsx';

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- root element exists in index.html
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme theme={matchaTheme}>
      <StoreProvider>
        <ChatProvider>
          <App />
        </ChatProvider>
      </StoreProvider>
    </Theme>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
