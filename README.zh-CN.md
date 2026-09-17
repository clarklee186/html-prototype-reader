# html-prototype-reader

简体中文 | [English](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-blue)
![Runtime](https://img.shields.io/badge/runtime-playwright--core%20%2B%20Chrome%2FEdge-orange)

面向 AI Agent 的 **HTML 原型渲染式读取与还原验收工具**。把设计工具导出的 HTML 原型（单页 / 多页 / JS 动态拼装）转成 Agent 可直接消费的结构化事实——组件树 + 计算样式 + 语义说明；并提供「还原结果 vs 原型」的验收 diff（同视口像素对比 + 结构 / 样式 / 交互差异清单）。

## 为什么需要它

Agent 直接读 HTML 源码（"裸读"）存在系统性遗漏：

- **computed style 不存在于源码中**——CSS 级联、继承、浏览器默认样式、`var()` 变量解析后的最终生效值，只有真渲染才知道。实测一个原型中 `var()` 引用 1,201 处、37 个自定义属性，裸读等于靠脑内模拟渲染。
- **布局定位不存在于源码中**——绝对定位坐标、flex / grid 实际排布、元素真实宽高。
- **纯解析库拿不到布局**——jsdom 无布局引擎（`getBoundingClientRect` 恒为 0），伪元素 computed style 未实现。
- **动态原型源码不可读**——实测某 783KB 原型中静态 HTML 仅 1KB，650KB 是 JavaScript，全部屏幕运行时用 `innerHTML` 拼出；7 个屏幕里 6 个初始不可见。
- **上下文截断**——大原型（22 万 token）在常规上下文预算内只能覆盖一半源码。

本工具用真实浏览器渲染后提取，把以上信息从"猜"变成"读"，并通过验收 diff 把「还原一致」从肉眼判断变成逐条可修的差异工单。

## 主要功能

### capture.js — 原型捕获（四模块）

| 模块 | 能力 |
|---|---|
| **extract** 渲染提取 | 完整 DOM 遍历 + `getBoundingClientRect` 布局定位 + computed style 白名单采集（对父级做继承 diff，只保留非继承差异，天然压缩体积） |
| **traverse** 交互遍历 | 入口自动发现（导航 / tab / `data-view` 等）→ 逐个点击 → 可见元素签名去重 → 分屏截图。多屏 JS 拼装原型必须经此通道，纯渲染会漏掉 6/7 的屏幕 |
| **compress** 上下文压缩 | 重复兄弟子树按结构签名折叠（`rep: N` 标记）、样式继承 diff、px 取整 |
| **output** 结构化产物 | `prototype.json` + `summary.md` + 分屏截图 |

覆盖的细节维度：伪元素（`::before/::after`，含 `content:''` + 绝对定位的装饰图层）、交互元素清单（button/input/select/textarea/[role]，含 disabled / required / placeholder / 所属覆盖层）、资源引用（img/srcset/background-image/@font-face、死引用检测）、**响应式断点清单**（从 CSSOM 提取全部 `@media` 条件并去重）、**主题态探针**（检测主题切换按钮，记录切换前后关键元素生效色）、弹窗 / 抽屉 / Toast 清单（隐藏的也抓取子树结构）、同源 iframe 递归、Canvas 尺寸记录、懒加载兜底（IntersectionObserver stub + `loading=eager` + 全页滚动）。

### diff.js — 还原验收

- **像素对比**：两边同视口 fullPage 截图，逐像素阈值比对，差异像素标红生成 `diff-overlay.png`，按 100px 块聚合出**差异热区**（映射到原型分区标注位置）
- **结构差异清单**：类缺失 / 多余（按出现频次排序）、类样式逐属性对比（采样高频类，精确到 `类 → 属性 → 原型值 vs 还原值`）、可见文本 multiset 差异、交互元素差异、页面高度偏差、资源死引用
- **确定性保障**：截图前冻结动画（animation paused + transition none）+ 反懒加载，动效时序不产生假差异
- 零 npm 依赖：像素比对在浏览器 canvas 内完成，PNG 无需本地解码

## 环境要求

| 依赖 | 要求 | 说明 |
|---|---|---|
| Node.js | ≥ 18（开发环境 22.x） | 无其他 npm 运行时依赖 |
| playwright-core | ≥ 1.40（开发环境 1.62.1） | 需自行安装（见下），不会自动下载 |
| 浏览器 | 本机 Chrome 或 Edge（任一即可） | 按序自动尝试 chrome → msedge → bundled Chromium（都没有才会触发浏览器下载） |
| 操作系统 | Windows / macOS / Linux | Windows 实测通过 |

## 安装

**方式一：Agent Skill 安装器（推荐）**

```bash
npx skills add clarklee186/html-prototype-reader
```

**方式二：克隆仓库**

```bash
git clone https://github.com/clarklee186/html-prototype-reader.git
```

**方式三：手动复制**——把 `SKILL.md`、`_meta.json`、`scripts/` 复制到你的 agent 技能目录（如 WorkBuddy 为 `~/.workbuddy/skills/html-prototype-reader/`）。

然后安装唯一的运行时依赖：

```bash
# 任选一个 node_modules 位置；脚本会按以下顺序自动解析：
# ① 当前 NODE_PATH ② ~/.workbuddy/binaries/node/workspace/node_modules ③ 脚本同级 node_modules
npm i playwright-core
```

## 使用方法

### ① 捕获原型

```bash
node scripts/capture.js <html文件或目录> <输出目录> [选项]

# 示例
node scripts/capture.js "C:/proto/dashboard.html" "C:/out/prototype"
node scripts/capture.js "C:/proto/pages/" "C:/out/prototype" --viewport 375x812
```

输入为目录时按文件名序逐页处理（多页原型）。产物：

| 文件 | 内容 |
|---|---|
| `summary.md` | **Agent 先读**：文件构成（标记/CSS/JS 字节比与 token 估算）、屏幕清单表、断点、主题态、覆盖层、资源失败清单 |
| `prototype.json` | 全量结构化数据（schema 见下） |
| `screen-NN.png` | 每屏截图（视觉基准） |

`prototype.json` 组件树节点字段：`t`=标签、`id`、`c`=class 数组、`r`={x,y,w,h}、`v`=可见性、`rep`=重复兄弟折叠数、`s`=样式 diff、`ps`=伪元素、`sem`=语义属性（role/aria/alt/placeholder/disabled…）、`tx`=叶子文本、`ch`=子节点、`img/canvas/iframe`=资源信息；页级另有 `screens[]`（每屏 tree + interactions 交互清单）、`overlays[]`（弹窗/Toast，隐藏的含子树）、`css`（规则统计 / 断点 / `customPropsByState` 主题变量 / fontFaces）、`theme`（切换探针）、`failedRequests`。

### ② 还原验收 diff

```bash
node scripts/diff.js <原型.html|URL> <还原.html|URL> <输出目录> [选项]

# 还原页跑在 dev server 上也可以直接比
node scripts/diff.js "C:/proto/dashboard.html" "http://localhost:5173" "C:/out/acceptance"
```

产物：`diff-report.md`（**先读**：差异率总览 + 热区表 + 样式不一致清单）、`diff-overlay.png`（差异像素标红）、`prototype.png` / `restored.png`、`diff.json`。

**判读口径**：像素差异率 <1% 且无样式不一致 → 一致；1–5% 先看热区是否集中在动效/图标；>5% 按热区逐区修复。diff 对比的是两边**初始渲染态**，多屏原型请按 capture 的屏幕清单逐屏还原后分别跑 diff。

### ③ 作为 Agent Skill 使用

把本仓库放入 agent 技能目录后，用户直接给出 HTML 原型文件并要求「还原 / 复刻 / 转成代码 / 分析页面结构 / 核对还原一致性」即可自动触发；标准工作流为：`capture.js` 读取 → Agent 还原 → `diff.js` 验收 → 按差异清单修复 → 再跑 diff 直至达标。

## 常见配置说明

### capture.js 选项

| 选项 | 默认值 | 说明 |
|---|---|---|
| `--viewport WxH` | `1440x900` | 渲染视口；做移动端还原可设 `375x812` |
| `--max-screens N` | `30` | 交互遍历的屏幕数上限，防止误点入口导致死循环 |
| `--timeout ms` | `45000` | 页面加载超时 |
| `DEBUG=1`（环境变量） | 关 | 输出逐屏捕获日志（入口命中 / 点击失败 / 去重结果），排查漏屏时开 |

### diff.js 选项

| 选项 | 默认值 | 说明 |
|---|---|---|
| `--threshold N` | `32` | 像素差阈值（单通道最大差值），调高可容忍轻微抗锯齿噪声 |
| `--block N` | `100` | 热区聚合块边长（px），调小可精确定位差异 |
| `--viewport WxH` | `1440x900` | **两边必须同视口**，否则尺寸不一致会进报告 |

### 常见场景配置建议

- **漏屏排查**：加 `DEBUG=1` 看每个入口的点击与去重结果；导航结构特殊的原型，可在 SKILL 使用说明中补充入口选择器
- **样式假差异多**：提高 `--threshold`（如 48）；仍集中在图标/字体渲染区可忽略
- **深色/浅色双主题**：capture 已输出 `customPropsByState` 与主题探针，还原时两套都要实现；diff 验收需分别对两种状态跑（还原侧切换状态后再次执行）
- **上下文超限**：优先读 `summary.md` 与截图，`prototype.json` 按屏、按子树下钻，不要一次性全量读入

## 已知边界

- 深层交互（弹窗内部内容、tab 嵌套、行内展开态）需触发后才可见，未触发的拿不到；必要时对具体入口手动触发再跑一次 capture
- Canvas 只记录尺寸与位置，位图内容不提取；跨域 iframe 只记录 src
- 屏幕去重按「可见元素 + 类签名」哈希，极相似屏幕可能被合并（受 `--max-screens` 保护）

## 实测基线（回归参考）

对 783KB 多屏仪表盘原型（JS 动态拼装、双主题、45 个 @media 块）：捕获 8 屏 / 908 可见元素 / 16 种断点 / 双主题探针，耗时 6s；diff 自比对差异率 0（4s）；注入主色/圆角变异后 4 项样式不一致精确定位到类 + 属性 + 值（3s）。

## License

[MIT](LICENSE)
