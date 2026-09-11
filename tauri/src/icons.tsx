// SVG 图标精灵（源 UI index.html 搬运：outline 系、24-grid、stroke 1.75）。
// 禁止图标 npm 包（迁移提示词硬性约束）；i-pin 为原应用置顶功能的同族补图。
// 源里的 i-text / i-image 两枚随卡片类型 chip 在 2026-09-11 退役（零引用），i-copy 随卡片
// 右上角的「复制」胶囊同日退役；源 UI 存档里仍有原图（clipboard-app/index.html），要恢复从那里取。

export function IconSprite() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" style={{ display: 'none' }} aria-hidden="true">
      <symbol id="i-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7.5" /><path d="m21 21-4.35-4.35" /></symbol>
      <symbol id="i-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></symbol>
      <symbol id="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="m20 6.5-11 11-5-5" /></symbol>
      <symbol id="i-layers" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="m12 2.8 8.6 4.6-8.6 4.6-8.6-4.6z" /><path d="m3.4 12.4 8.6 4.6 8.6-4.6" /><path d="m3.4 16.9 8.6 4.6 8.6-4.6" /></symbol>
      <symbol id="i-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></symbol>
    </svg>
  );
}

export function Icon({ id, size = 16, className }: { id: string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <use href={'#' + id} />
    </svg>
  );
}
