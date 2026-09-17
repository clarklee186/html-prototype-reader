---
name: html-prototype-reader
description: 完整读取设计工具导出的 HTML 原型（单页/多页/JS 动态拼装），渲染后提取组件树 + 样式属性 + 语义说明，供前端代码还原；并可将「还原结果 vs 原型」做同视口像素对比 + 结构/样式/交互差异清单的验收 diff。当用户给出现成 HTML 原型文件并要求"还原 / 复刻 / 转成代码 / 分析页面结构 / 核对还原一致性"时使用。解决 agent 裸读源码遗漏 computed style、布局定位、懒加载内容、双主题、伪元素、多屏隐藏内容的问题。
---

# html-prototype-reader

把 HTML 原型转成"渲染后的结构化事实"，替代"裸读源码 + 脑内模拟渲染"。

## 何时用

- 输入是 .html / .htm 文件或目录（设计工具导出、AI 生成、手写均可）
- 任务是代码还原、视觉复刻、结构分析、还原一致性检查
- 原型中含 JS 动态内容（innerHTML 拼装、多屏切换、懒加载、主题切换）时尤其必须用

## 何时不用

- 只需要读纯静态文本内容（直接读文件更快）
- 需要跨页面爬取外链站点（这是浏览器自动化任务，不是原型读取）

## 用法

```bash
# ① 捕获原型 → 结构化事实
node <本skill目录>/scripts/capture.js \
  "<html文件或目录>" "<输出目录>" [--viewport 1440x900] [--max-screens 30] [--timeout 45000]

# ② 验收 diff：还原结果 vs 原型（两边都可以是本地文件或 http(s) URL）
node <本skill目录>/scripts/diff.js \
  "<原型.html|URL>" "<还原.html|URL>" "<输出目录>" [--viewport 1440x900] [--threshold 32] [--block 100]
```

- 脚本自动尝试本机 Chrome → Edge → bundled Chromium，无需下载浏览器；diff 需要 `--allow-file-access-from-files`（脚本已带）
- 脚本按顺序解析 playwright-core：① 当前 NODE_PATH ② 本机托管 node 工作区（`~/.workbuddy/binaries/node/workspace/node_modules`）③ 同级 node_modules。都没有时先安装：`npm i playwright-core`（装进上述任一位置即可）
- 输入为目录时按文件名序逐页处理（多页原型）
- DEBUG=1 可看 capture 逐屏捕获日志

本机（WorkBuddy 环境）可直接用的示例：

```bash
NODE_PATH="C:/Users/admin/.workbuddy/binaries/node/workspace/node_modules" \
node "C:/Users/admin/.workbuddy/skills/html-prototype-reader/scripts/capture.js" \
  "C:/path/to/proto.html" "C:/path/to/out"
```

## 产物（输出目录）

| 文件 | 内容 |
|---|---|
| `summary.md` | **先读这个**：文件构成、屏幕清单表、断点、主题态、伪元素/交互态统计、资源失败清单 |
| `prototype.json` | 全量结构化数据（见下 schema） |
| `screen-NN.png` | 每屏截图（视觉基准） |

## prototype.json schema

```
pages[].screens[]          每屏一个捕获
  .name / .entry           屏名与点击入口（initial = 首屏）
  .heading                 屏内最大标题
  .shot                    截图文件名
  .elementCount            可见元素数
  .tree                    组件树（body 起，见下）
  .interactions[]          可见交互元素清单（tag/cls/text/sem/rect/cursor/inOverlay）
pages[].overlays[]         弹窗/抽屉/Toast 清单（hiddenNow + 完整子树 tree，触发后才可见的也在）
pages[].css                CSS 事实：totalRules / hover / focus / pseudoRules / keyframes /
                           mediaConditions[] / breakpoints[]（已去重，px 数值）/
                           customPropsByState{选择器→{--var:值}} / fontFaces[]
pages[].theme              主题切换探针：toggleFound / toggles[]（切换前后 body 类与关键元素生效色）
pages[].failedRequests     资源加载失败（死引用，还原时要处理）
fileComposition            字节构成（标记/CSS/JS）与 token 估算 —— 判断裸读是否可行

组件树节点：
  t=标签  id  c=class数组  r={x,y,w,h}  v=可见(1/0)  rep=N(重复兄弟折叠)
  s=样式diff(与父级 computed 对比后的非继承差异, 白名单属性)
  ps=伪元素[{pseudo,content,position,decorative,...}]   ← content:''+absolute 的装饰层也会被抓到
  sem=语义与状态(role/aria-*/alt/placeholder/name/type/href/disabled/required/checked/indeterminate/value/selected/open/multiple/options/editableText/list...)
  tx=叶子文本   ch=子节点   img/canvas/iframe=资源信息
```

## agent 消费流程（还原任务）

1. 读 `summary.md` 建立全局：几屏、几个弹窗、几组主题、多少断点、有无死引用。
2. 逐屏看截图建立视觉基准（多模态）。
3. 按屏读 `prototype.json` 中对应 `tree`：先骨架（t/c/r/rep），再按需下钻 `s` 样式。
4. 交互逐条对照 `interactions`（含 disabled/required/placeholder/overlay 归属）。
5. 还原清单必须覆盖：全部断点、全部主题态（customPropsByState）、伪元素装饰层（ps）、隐藏 overlay 的触发路径（若源码可见触发按钮）、死引用处理。
6. `rep` 折叠的重复项展开还原时不要丢数量。

## diff 产物与判读（验收环节）

| 文件 | 内容 |
|---|---|
| `diff-report.md` | **先读这个**：像素差异率总览 + 差异热区（按原型分区标注）+ 样式不一致清单（类→属性→双方值）+ 缺失类/文本/交互 |
| `diff-overlay.png` | 差异像素标红覆盖层，对照 prototype.png / restored.png |
| `diff.json` | 全量数据 |

判读口径：像素差异率 <1% 且无样式不一致 → 一致；1–5% 先看热区是否集中在动效/图标；>5% 按热区逐区修复。动画已冻结（paused + transition:none），差异不含动效时序。**diff 对比的是两边初始渲染态**：多屏原型请先用 capture.js 逐屏确认屏幕清单，再对每屏的还原结果分别跑 diff。

## 已知边界（不要假设拿到的东西不存在）

- 深层交互（弹窗内部内容、tab 嵌 tab、行内展开态）只在被触发后可见；overlay 结构若未在初始 DOM 中则拿不到。必要时对具体入口手动触发再跑一次 capture。
- Canvas 只记录尺寸与节点位置，位图内容需另行导出。
- iframe：同源内容会递归提取（深度上限 2，`iframe.sameOrigin=true` + `iframe.content` 子树）；跨域或不可访问时只记录 `src`（`blocked=true`）。递归依赖启动参数 `--allow-file-access-from-files`（已内置），file:// 原型同样生效。
- 屏幕去重按"可见元素+类签名"哈希，极相似的屏可能被合并；MAX_SCREENS 上限默认 30。
- 截图前会注入冻结动画样式（animation paused + transition 0.001s），保证同一原型多次运行的分屏截图可复现；依赖 transitionend 显示内容的原型不受影响（过渡仍会触发，只是时长趋零）。

## 维护记录

- 2026-09-17 建立。四模块：extract（渲染+computed style 父级 diff+伪元素双条件）/ traverse（入口发现→逐个点击→签名去重→分屏截图）/ compress（rep 折叠+样式裁剪）/ output（prototype.json+summary.md）。
- 2026-09-17 增加验收 diff 脚本（diff.js）：零 npm 依赖，像素比对在浏览器 canvas 内完成（需 --allow-file-access-from-files）；类样式按频次采样 250 类逐属性对比；变异实测（主色/圆角变量）能定位到具体类+属性+值。
- 2026-09-17 **v1.0.1 修复**：① 同源 iframe 递归提取落地（深度上限 2，file:// 也生效）；② capture 截图前冻结动画/过渡，分屏截图可复现；③ 抽出 `shared.js` 作为 STYLE_PROPS / DIFF_PROPS / FREEZE_CSS / LAUNCH_ARGS / IFRAME_DEPTH_LIMIT 单一真理源（此前 capture 40+ 属性 vs diff 14 属性两份清单已漂移）；④ 去掉脚本内硬编码用户路径（改 os.homedir() 派生）；⑤ 清理死代码（无用句柄预取、无效 filter）、补 entriesFound/entriesClicked/iframe 统计进 summary；⑥ 热区标注改为取最小包含区间，不再被整页容器吃掉；⑦ 补 .gitignore / package.json（engines + npm scripts）。
- 2026-09-17 **v1.0.5 组件状态覆盖补全**：覆盖矩阵 7/24 → 24/24（fixture：checkbox/radio/单选多选 select/搜索框/textarea/range/number/details/dialog 开与关/自定义 switch·slider/aria-pressed/contenteditable/datalist/离屏抽屉）。根因是 attribute vs property：JS 设值不更新 attribute（el.value/el.checked/el.selected/el.open 读 property）；补 aria-checked/aria-selected/aria-expanded/aria-pressed/aria-valuenow 等状态属性、select 的 options/selectedOptions/multiple、indeterminate、contenteditable 文本、dialog/details 的 open、progress/meter 的 value/max；interactiveList 增 DIALOG/DETAILS/OPTION/PROGRESS/METER/isContentEditable 与 offViewport 标记（off-canvas 抽屉，按文档流范围判断，避免把普通滚动内容误标）。
- 2026-09-17 **v1.0.4 新增 dead-content 报告**：AI 生成原型常多版本内容共存（实测 1,424 条 CSS 规则中 1,030 条任一时刻休眠；605 button/285 input 藏在 JS 模板字符串）。capture 遍历后汇总各屏 token 并集，输出 pages[].deadContent：死 CSS 三分类（matchedNow / dormant=token 在其他屏出现过 / notSeenInCapture=捕获中从未出现，可能在未访问屏幕或主题态激活）、重复 id、版本残留类名（-old/-v2/-backup 模式）、隐藏分支（排除 head/script 等天然隐藏标签，父级可见才算分支根）。实现要点：token 并集与 attrsText 在 captureScreen 内收集（attrsText 上限 400KB）。
- 关键坑（已修）：① 动态原型点击导航会整树重建 DOM，**句柄必须每轮重新查询**，预取会报 "Element is not attached"；② 伪元素必须按 content!=='none' 且记录 position，content:'' 的装饰层不能排除；③ 断点提取 parseFloat 去 'px'；④ **Playwright evaluate 传"字符串函数表达式 + 解构参数"会按表达式求值返回 undefined，必须传真实函数对象**（diff.js 的 COMPARE_FN）；⑤ 截图确定性：两侧共用同一份 FREEZE_CSS（用 transition-duration 0.001s 而非 transition:none，避免依赖 transitionend 的原型失去内容）。
