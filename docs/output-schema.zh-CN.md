# 输出结构

## capture.js

| 文件 | 内容 |
|---|---|
| `summary.md` | **Agent 先读**：文件构成（标记/CSS/JS 字节比与 token 估算）、屏幕清单表、入口点击统计、断点、主题态、覆盖层、iframe 递归统计、资源失败清单 |
| `prototype.json` | 全量结构化数据（见下） |
| `screen-NN.png` | 每屏一张截图（视觉基准） |

### prototype.json

页级字段：

| 字段 | 内容 |
|---|---|
| `pages[].screens[]` | 每屏一条：`name`、`entry`、`heading`、`shot`、`elementCount`、`tree`、`interactions` |
| `pages[].overlays[]` | 弹窗 / 抽屉 / Toast，含量子树的隐藏项（`hiddenNow` 标记） |
| `pages[].css` | 规则统计、`:hover` / `:focus` / 伪元素规则数、`mediaConditions`、去重后的 `breakpoints[]`、`customPropsByState`（各选择器的主题变量）、`fontFaces[]` |
| `pages[].theme` | 主题切换探针：是否检测到切换按钮，以及关键元素切换前后的生效色 |
| `pages[].iframes` | 递归统计：总数、`sameOriginRecursed`、`crossOriginOrBlocked` |
| `pages[]` | `entriesFound`、`entriesClicked`、`failedRequests`、页面标题/高度、所用浏览器通道 |
| `fileComposition` | 总字节、token 估算、标记/CSS/JS 占比——用来判断"裸读"是否本来可行 |

组件树节点字段：

| 字段 | 含义 |
|---|---|
| `t` | 标签名 |
| `id`、`c` | 元素 id 与 class 数组 |
| `r` | `getBoundingClientRect` 得到的 `{x, y, w, h}` |
| `v` | 是否可见 |
| `rep` | 被折叠进该节点的连续相同兄弟数 |
| `s` | 相对父级的样式 diff（只保留非继承差异） |
| `ps` | 伪元素：`content`、`position`、是否装饰层、关键视觉属性 |
| `sem` | 语义属性：role、aria-*、alt、placeholder、type、disabled、required、href… |
| `tx` | 叶子文本（仅可见元素，已裁剪空白） |
| `ch` | 子节点 |
| `img` / `canvas` / `iframe` | 资源信息；同源 iframe 的递归子树在 `iframe.content` |

### 建议的消费顺序（给还原 agent）

1. 先读 `summary.md` 建立全局。
2. 看截图建立视觉基准。
3. 按屏读 `tree`：先骨架（`t`/`c`/`r`/`rep`），再按需下钻 `s`。
4. 用 `interactions` 逐条对照控件，注意 `inOverlay` 归属。
5. 还原清单务必覆盖：全部断点、两种主题态、装饰性伪元素图层、隐藏覆盖层的触发路径、死引用处理。

## diff.js

| 文件 | 内容 |
|---|---|
| `diff-report.md` | **Agent 先读**：差异率总览、按文档大纲标注的热区表、样式不一致清单、缺失类/文本/交互 |
| `diff-overlay.png` | 差异像素标红的覆盖层图 |
| `prototype.png` / `restored.png` | 实际参与比对的两张截图 |
| `diff.json` | 全量数据：像素统计、结构差异、热区、资源失败 |
