<div align="center">

# html-prototype-reader

**让 Agent 真正"看见"HTML 原型——渲染式读取、还原、验收**

<img src="assets/banner.webp" alt="html-prototype-reader — 让 Agent 真正看见 HTML 原型" width="100%">

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-blue)

[English](README.md) · [CLI 参考](docs/cli-reference.zh-CN.md) · [输出结构](docs/output-schema.zh-CN.md)

</div>

---

## 这是什么

一个 agent 技能加两个命令行工具。`capture.js` 用真实浏览器渲染设计工具导出的 HTML 原型，按浏览器的方式去读它——每一个屏幕、每一条生效样式、每一个交互——然后写出 Agent 能据此还原代码的组件树。`diff.js` 闭环：把还原结果与原型逐像素比对，给出可逐条修复的差异清单。

它存在的理由很简单：Agent 读 HTML 源码，读到的是页面的**描述**，不是页面本身。

## 为什么需要它

- **computed style 不在源码里。** 级联、继承、浏览器默认样式、`var()` 解析后的最终值，只有渲染后才存在。实测一个原型：`var()` 引用 1,201 处、37 个自定义属性。
- **布局定位不在源码里。** 绝对坐标、flex/grid 的真实排布、元素实际尺寸。
- **动态原型在源码层不可读。** 实测某 783KB 原型中静态 HTML 仅 1KB、JavaScript 是 650KB；全部屏幕运行时用 `innerHTML` 拼出，7 屏里有 6 屏初始不可见。
- **纯解析库替代不了。** jsdom 没有布局引擎（`getBoundingClientRect` 恒为 0），也不实现伪元素的 computed style。

## 你会得到什么

<img src="assets/features.webp" alt="一次读全一个原型、把不一致变成工单、零依赖本地可跑" width="100%">

一份结构化 `prototype.json`（组件树、样式 diff、交互清单、断点、主题态、覆盖层、iframe 子树）、一份供 Agent 先读的 `summary.md`、每屏一张截图；还原之后再拿到 `diff-report.md`——像素差异率、带标注的差异热区、以及逐条样式不一致清单。

## 工作方式

`capture.js` 走四步：渲染提取（完整 DOM 遍历 + `getBoundingClientRect` + computed style 白名单，对父级做继承 diff，只留非继承差异）、交互遍历（发现导航/tab 入口逐个点击，按可见元素签名去重分屏）、压缩（折叠重复兄弟子树、数值取整）、落盘。截图前冻结动画，保证基准可复现。`diff.js` 把两边同视口重渲染、同样冻结，在浏览器 canvas 内逐像素比对——不依赖图像库，也不在本地解码 PNG。

## 快速开始

```bash
npm i                                     # 只装 playwright-core（可选 peer 依赖）

node scripts/capture.js "C:/proto/dashboard.html" "C:/out/prototype"
node scripts/diff.js "C:/proto/dashboard.html" "http://localhost:5173" "C:/out/acceptance"
```

先读 `C:/out/prototype/summary.md`：屏幕、断点、主题态、覆盖层、死引用一页看全。`capture.js` 传目录即可处理多页原型；`diff.js` 两边都可以是本地文件或运行中的 dev server 地址。

## 安装

```bash
npx skills add clarklee186/html-prototype-reader           # 作为 agent 技能安装
# 或
git clone https://github.com/clarklee186/html-prototype-reader.git && cd html-prototype-reader && npm i
```

环境要求：Node ≥ 18、`playwright-core` ≥ 1.40、本机 Chrome 或 Edge（两者都没有时才会下载自带 Chromium）。`playwright-core` 解析顺序：`NODE_PATH` → `~/.workbuddy/binaries/node/workspace/node_modules` → 同级 `node_modules`。

## CLI

```bash
node scripts/capture.js <html文件或目录> <输出目录> [--viewport 1440x900] [--max-screens 30] [--timeout 45000]
node scripts/diff.js    <原型|URL>      <还原|URL>    <输出目录> [--viewport 1440x900] [--threshold 32] [--block 100]
```

完整选项表、判读口径与场景建议见 [docs/cli-reference.zh-CN.md](docs/cli-reference.zh-CN.md)；产物清单与 `prototype.json` 字段速查见 [docs/output-schema.zh-CN.md](docs/output-schema.zh-CN.md)。

## 已知边界

深层交互（弹窗内容、tab 嵌套、行内展开态）只有被触发后才存在。Canvas 位图不提取，跨域 iframe 只记录 `src`（同源 iframe 递归至深度 2）。屏幕去重基于签名，极相似屏幕可能被合并——由 `--max-screens` 兜底。

## 可信产物

对一个 783KB 多屏仪表盘原型（JS 动态拼装、双主题、45 个 `@media` 块）实测：捕获得到 8 屏、908 个可见元素、16 种断点与双主题探针，耗时 6–7 秒；自比对差异率 0；注入主色/圆角变异后，4 项样式不一致精确定位到类 + 属性 + 双方值。

## 许可证

[MIT](LICENSE)

## 关于作者

由 [Clark Lee (@clarklee186)](https://github.com/clarklee186) 构建与维护。欢迎提 Issue 与 PR——改动前请先读 [AGENTS.md](AGENTS.md)，里面记录了必须守住的那些不变量。
