/**
 * html-prototype-reader · shared
 * capture.js 与 diff.js 共用的常量：
 *  - STYLE_PROPS：capture 全量采集的计算样式属性（唯一真理源）
 *  - DIFF_PROPS：diff 验收比对的高信号子集（避免 transition/opacity 等噪声项污染报告）
 *  - FREEZE_CSS：截图确定性保障（两侧必须用同一份，否则会产生假的像素差异）
 *  - LAUNCH_ARGS：浏览器启动参数（file:// 下的 canvas 读取与同源 iframe 递归都依赖它）
 *  - TUNING：调优参数集中处（不要散落魔数到脚本里）
 *  - SCHEMA_VERSION：产物结构版本
 */
'use strict';

/** capture 全量采集的属性 */
const STYLE_PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'zIndex', 'opacity', 'overflow',
  'flexDirection', 'justifyContent', 'alignItems', 'flexWrap', 'gap',
  'gridTemplateColumns', 'gridTemplateRows', 'gridColumn', 'gridRow', 'gridAutoFlow',
  'padding', 'margin', 'borderRadius', 'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
  'backgroundColor', 'backgroundImage', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
  'textAlign', 'letterSpacing', 'textTransform', 'textDecorationLine', 'textOverflow', 'whiteSpace',
  'boxShadow', 'transform', 'transition', 'cursor', 'visibility', 'aspectRatio', 'objectFit', 'minWidth', 'maxWidth',
];

/** 对比时始终保留（即使与父级相同）的布局关键属性 */
const ALWAYS_KEEP = ['display', 'position', 'flexDirection', 'justifyContent', 'alignItems', 'gridTemplateColumns', 'visibility', 'overflow'];

/**
 * diff 验收比对的属性子集。
 * 刻意排除 transform / transition / opacity / aspectRatio 等：还原实现常合理不同（不同缓动、不同合成方式），
 * 纳入会产生大量噪声差异，掩盖真正的颜色/排版/尺寸问题。需要更严格时可临时改这里并重跑。
 */
const DIFF_PROPS = [
  'display', 'position', 'backgroundColor', 'color', 'fontSize', 'fontWeight', 'lineHeight',
  'padding', 'margin', 'borderRadius', 'boxShadow', 'flexDirection', 'gap', 'border', 'textAlign',
];

/**
 * 冻结动画与过渡，保证同一页面两次截图像素一致。
 * 用过渡时长 0.001s 而非 transition:none —— 前者同样确定，但保留 transitionend 事件，
 * 不会让依赖 transitionend 显示内容的原型失去内容。
 */
const FREEZE_CSS = `*,*::before,*::after{animation-play-state:paused !important;animation-delay:-9999s !important;animation-duration:0.001s !important;transition-duration:0.001s !important;transition-delay:0s !important;caret-color:transparent !important}`;

/**
 * file:// 页面需要放开文件访问：canvas 读图（diff）与同源 iframe 内容读取（capture）都依赖。
 * 信任边界：该参数使页面内 JS 可跨 file:// 读取本地文件，因此**只应对可信原型运行**；
 * 来源不可信时请加 --no-network 阻断网络外发。
 */
const LAUNCH_ARGS = ['--allow-file-access-from-files'];

/** 同源 iframe 递归深度上限（防止套娃撑爆 JSON） */
const IFRAME_DEPTH_LIMIT = 2;

/** 产物 schema 版本：字段增删时递增，消费者据此做兼容判断 */
const SCHEMA_VERSION = 1;

/** 调优参数集中处 */
const TUNING = {
  clickSettleMs: 320,        // 点击入口后等待渲染
  scrollStepPx: 800,         // 反懒加载滚动步长
  scrollIntervalMs: 35,      // 滚动步间隔
  settleAfterLoadMs: 400,    // 加载与反懒加载后的稳定等待
  networkIdleMs: 6000,       // networkidle 容错上限（长连接页面不阻塞）
  clickTimeoutMs: 2000,      // 单个入口点击超时
  treeDepthLimit: 24,        // 组件树递归上限
  textSampleLimit: 1500,     // 文本采样上限
  classSampleLimit: 250,     // 类样式采样上限
  attrsTextLimit: 400000,    // 可达性判断用的属性串上限
  compareMaxHeightPx: 12000, // 超过则分带比对（避免三份全尺寸位图 OOM）
  compareBandPx: 3000,       // 分带高度
  compareRetry: 1,           // 结构快照失败重试次数
  wsMaxChars: 100,           // 文本节点截断
};

module.exports = {
  STYLE_PROPS, ALWAYS_KEEP, DIFF_PROPS, FREEZE_CSS,
  LAUNCH_ARGS, IFRAME_DEPTH_LIMIT, SCHEMA_VERSION, TUNING,
};
