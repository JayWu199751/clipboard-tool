// 卡片（源 UI §4，2026-09-11 局部改版）：内容在上、meta 行在下——meta 行 = 来源应用 · 时间 ·
//（可选）置顶 ·（可选）内联备注，单行省略号；文字卡内容 3 行 clamp，图片卡 150px 真实缩略图
//（棋盘格底）+ mono 文件名。类型（文字/图片）不再有 chip 标识，只由内容形态本身区分；
// 上文两项改版的动机与取舍见 docs/changelog.md 同日两条（复制胶囊的删除见同日第三条）。
// 点击 = 仅选中、双击 = 复制并粘贴（用户确认按原应用鼠标语义）。
// 右上角的「复制」胶囊 2026-09-11 随用户要求删除（「hover 与选中都不再显示」）——鼠标复制的
// 入口只剩双击一条；连带退役 .card__copy 一族样式、i-copy 图标符号、文字卡的 68px 让位，
// 以及只被那条让位规则读的 data-type 属性（零引用者成套退役，见 docs/changelog.md 同日条目）。
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
      onClick={onSelect}
      onDoubleClick={onCopy}
    >
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
      <div className="card__meta">
        <span className="src">{item.source}</span>
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
    </li>
  );
}
