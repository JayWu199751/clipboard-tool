// 卡片（源 UI §4）：meta 行 = 仅图标的类型 chip · 来源 · 时间 ·（可选）置顶/内联备注，
// 单行省略号；文字卡 3 行 clamp，图片卡 150px 真实缩略图（棋盘格底）+ mono 文件名；
// hover/选中浮现「复制」胶囊。点击 = 仅选中、双击/胶囊 = 复制并粘贴（用户确认按原应用）。
// 选中态 = accent tint + accent 描边（禁止实心大色块）。

import type { ReactNode } from 'react';
import type { ClipItem } from './clipStore';
import { Icon } from './icons';
import { formatTime, highlight } from './panelView';

function renderHighlight(text: string, query: string): ReactNode {
  const spans = highlight(text, query);
  const [only] = spans;
  if (spans.length === 1 && !only?.hit) return text;
  return spans.map((span, i) =>
    span.hit ? <mark key={i}>{span.text}</mark> : <span key={i}>{span.text}</span>,
  );
}

interface ClipCardProps {
  item: ClipItem;
  selected: boolean;
  copied: boolean;
  query: string;
  /** 非 null = 本卡正在内联编辑备注 */
  noteDraft: string | null;
  onSelect(): void;
  onCopy(): void;
  onNoteDraft(draft: string): void;
  onNoteSave(): void;
  onNoteCancel(): void;
}

export function ClipCard({ item, selected, copied, query, noteDraft, onSelect, onCopy, onNoteDraft, onNoteSave, onNoteCancel }: ClipCardProps) {
  const sep = (key: string) => <span className="sep" key={key}>·</span>;
  return (
    <li
      className={'card' + (selected ? ' is-selected' : '') + (copied ? ' is-copied' : '')}
      role="option"
      aria-selected={selected}
      data-selected={selected ? 'true' : 'false'}
      data-type={item.type}
      onClick={onSelect}
      onDoubleClick={onCopy}
    >
      <div className="card__meta">
        <span className="card__type"><Icon id={item.type === 'image' ? 'i-image' : 'i-text'} size={12} /></span>
        {sep('s1')}<span className="src">{item.source}</span>
        {sep('s2')}<span>{formatTime(item.ts, Date.now())}</span>
        {item.pinned && <>{sep('s3')}<span className="card__pin" aria-label="已置顶"><Icon id="i-pin" size={12} /></span></>}
        {noteDraft !== null ? (
          <>
            {sep('s4')}
            <input
              type="text"
              className="note-input"
              placeholder="添加备注…"
              maxLength={200}
              spellCheck={false}
              aria-label="此条目的备注"
              value={noteDraft}
              autoFocus
              onChange={(event) => onNoteDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { event.preventDefault(); onNoteCancel(); }
                else if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); onNoteSave(); }
              }}
              onBlur={onNoteSave}
              onClick={(event) => event.stopPropagation()}
            />
          </>
        ) : item.note ? (
          <>{sep('s5')}<span className="card__note" title={item.note}>{query ? renderHighlight(item.note, query) : item.note}</span></>
        ) : null}
      </div>
      {item.type === 'image' ? (
        <>
          <div className="card__thumb">
            <img src={item.src} alt="剪贴板图片" draggable={false} />
          </div>
          <div className="card__name">{item.content}</div>
        </>
      ) : (
        <div className="card__body">{query ? renderHighlight(item.content, query) : item.content || '（空内容）'}</div>
      )}
      <button
        type="button"
        className="card__copy"
        aria-label={item.type === 'image' ? '复制图片' : '复制文字'}
        onClick={(event) => { event.stopPropagation(); onSelect(); onCopy(); }}
      >
        <Icon id="i-copy" size={12} />
        复制
      </button>
    </li>
  );
}
