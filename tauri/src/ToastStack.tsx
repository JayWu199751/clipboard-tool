// 底部胶囊 toast 栈（源 UI §6）：复制成功 = 绿勾 + 「文字已复制 · 来源 · 时间」；
// 删除 = 红色图标 + 「撤销」按钮（6s）。aria-live 由栈容器承担，多条排队不打断。

import { Icon } from './icons';

export interface ToastSpec {
  id: number;
  msg: string;
  dim?: string;
  kind: 'success' | 'error';
  actionLabel?: string;
  leaving?: boolean;
}

interface ToastStackProps {
  toasts: ToastSpec[];
  onAction(id: number): void;
}

export function ToastStack({ toasts, onAction }: ToastStackProps) {
  return (
    <div className="toast-stack" id="toast-stack" aria-live="polite" role="status">
      {toasts.map((toast) => (
        <div key={toast.id} className={'toast' + (toast.leaving ? ' is-leaving' : '')}>
          <span className={'toast__icon' + (toast.kind === 'error' ? ' toast__icon--error' : '')}>
            <Icon id={toast.kind === 'error' ? 'i-x' : 'i-check'} size={14} />
          </span>
          <span className="toast__msg">
            {toast.msg}
            {toast.dim ? <> <span className="dim">{toast.dim}</span></> : null}
          </span>
          {toast.actionLabel && (
            <button type="button" className="toast__action" onClick={() => onAction(toast.id)}>
              {toast.actionLabel}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
