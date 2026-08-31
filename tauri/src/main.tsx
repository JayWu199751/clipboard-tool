// api 适配层必须先于 App 执行：它向 window 注入 clipboardAPI（App 里的 mock 兜底只在缺失时生效）
import './api';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
