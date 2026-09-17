# CLI 参考

两个工具都是普通 Node 脚本；`npm run capture -- <参数>` 与 `npm run diff -- <参数>` 是等价快捷方式。

## capture.js

```bash
node scripts/capture.js <html文件或目录> <输出目录> [选项]
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `--viewport WxH` | `1440x900` | 渲染视口；做移动端还原可设 `375x812` |
| `--max-screens N` | `30` | 交互遍历的屏幕数上限，防止误点入口导致死循环 |
| `--timeout ms` | `45000` | 页面加载超时 |
| `--shot-format` | `png` | `png` 或 `jpeg`；后者在长页面上体积小得多 |
| `--jpeg-quality N` | `82` | `--shot-format jpeg` 时的质量 |
| `--no-network` | 关 | 阻断一切非 `file://`/localhost 请求（原型来源不可信时用） |
| `DEBUG=1`（环境变量） | 关 | 输出逐屏捕获日志（入口命中 / 点击失败 / 去重结果），排查漏屏时开 |

输入为目录时按文件名序逐页处理。

## diff.js

```bash
node scripts/diff.js <原型.html|URL> <还原.html|URL> <输出目录> [选项]
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `--threshold N` | `32` | 像素差阈值（单通道最大差值），调高可容忍轻微抗锯齿噪声 |
| `--block N` | `100` | 热区聚合块边长（px），调小可精确定位差异 |
| `--viewport WxH` | `1440x900` | 两边必须同视口，否则尺寸不一致会进报告 |
| `--max-height px` | `12000` | 超过该高度按分带比对至上限，报告标注已截断 |
| `--overlay-format` | `png` | `png` 或 `jpeg` |

## 降级与退出码

两个工具都会把每一处降级记录到 `warnings[]`（并在 `summary.md` / `diff-report.md` 顶部列出），产物带 `schemaVersion`。

| 退出码 | 含义 |
|---|---|
| 0 | 已测量且未发现问题 |
| 2 | 某个维度未产出（快照失败或页面加载失败）——`structure` / `pixel` 为 `null` 而非 0。**不等于通过。** |
| 1 / 3 | 工具级失败（参数错误、无可用浏览器） |

## 判读口径

像素差异率 <1% 且无样式不一致 → 一致；1–5% 先看热区是否集中在动效/图标区域；>5% 按热区逐区修复。

diff 对比的是两边**初始渲染态**。多屏原型请按 capture 的屏幕清单逐屏还原后，分别跑一次 diff。

## 场景建议

- **capture 漏屏** —— 加 `DEBUG=1` 看逐入口日志；导航结构特殊的原型，扩展入口选择器。
- **样式假差异多** —— 提高 `--threshold`（如 `48`）；若差异仍集中在图标/字体渲染区，通常可以忽略。
- **深色/浅色双主题** —— capture 已输出 `customPropsByState` 与主题探针；还原时两套都要实现，并分别对两种状态跑 diff。
- **上下文超限** —— 先读 `summary.md` 与截图，再按屏、按子树下钻 `prototype.json`，不要一次性全量读入。
