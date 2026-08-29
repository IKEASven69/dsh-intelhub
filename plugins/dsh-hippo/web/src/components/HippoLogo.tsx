/**
 * hippo 品牌 logo：几何河马脸（来自 docs/gui-mockup.html 的定稿设计）。
 * 紫色渐变徽章 + 面部用 CSS 变量（亮色=深墨/暗色=白，保证对比度）+
 * 品牌紫五官，呼应项目名。
 */
export function HippoLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="hippo" role="img">
      <defs>
        <linearGradient id="hippo-badge" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7c5cff" />
          <stop offset="100%" stopColor="#5a3fe0" />
        </linearGradient>
      </defs>
      {/* 耳朵（渐变底圈 + 面色内圈） */}
      <circle cx="9.5" cy="8.2" r="3.6" fill="url(#hippo-badge)" />
      <circle cx="22.5" cy="8.2" r="3.6" fill="url(#hippo-badge)" />
      <circle cx="9" cy="7.5" r="3.4" fill="var(--hippo-face, #2a2150)" />
      <circle cx="23" cy="7.5" r="3.4" fill="var(--hippo-face, #2a2150)" />
      {/* 脸 */}
      <rect x="4" y="8" width="24" height="18" rx="9" fill="var(--hippo-face, #2a2150)" />
      {/* 五官（品牌紫，两主题均可辨） */}
      <circle cx="11.5" cy="14.5" r="1.7" fill="#8b7bff" />
      <circle cx="20.5" cy="14.5" r="1.7" fill="#8b7bff" />
      <rect x="10" y="20.5" width="3.4" height="4.2" rx="1.7" fill="#8b7bff" />
      <rect x="18.6" y="20.5" width="3.4" height="4.2" rx="1.7" fill="#8b7bff" />
    </svg>
  );
}
