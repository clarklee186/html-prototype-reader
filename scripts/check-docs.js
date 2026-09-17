#!/usr/bin/env node
/**
 * 文档一致性校验（npm test 调用）：把今天两次人工发现的漂移固化成自动检查
 *  ① 中英 README 结构对等（章节数、代码块数一致）
 *  ② README 引用的 assets 图片存在，且不出现「英文 README 引中文图」这类语言错配
 *  ③ README 覆盖 capture/diff 的全部 CLI 默认值（防止文档落后于代码）
 *  ④ docs/ 中英成对存在
 *  ⑤ README 引用的仓库内链接目标存在
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const problems = [];
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = p => fs.existsSync(path.join(ROOT, p));

const en = read('README.md');
const zh = read('README.zh-CN.md');

/* ① 结构对等 */
const count = (s, re) => (s.match(re) || []).length;
const h2en = count(en, /^## /gm), h2zh = count(zh, /^## /gm);
const blocksEn = count(en, /```/g), blocksZh = count(zh, /```/g);
if (h2en !== h2zh) problems.push(`README 章节数不对等：EN ${h2en} vs ZH ${h2zh}`);
if (blocksEn !== blocksZh) problems.push(`README 代码块分隔数不对等：EN ${blocksEn} vs ZH ${blocksZh}`);
if (blocksEn % 2 !== 0) problems.push('README 代码块未闭合');

/* ② 图片引用 */
const imgs = [...en.matchAll(/src="(assets\/[^"]+)"/g)].map(m => m[1]);
for (const img of imgs) if (!exists(img)) problems.push(`README.md 引用的图片不存在：${img}`);
// 语言错配：英文 README 不应引用 .zh-CN 资源，反之亦然
for (const img of imgs) if (/\.zh-CN\./.test(img)) problems.push(`README.md（英文）引用了中文资源：${img}`);
const zhImgs = [...zh.matchAll(/src="(assets\/[^"]+)"/g)].map(m => m[1]);
for (const img of zhImgs) if (!exists(img)) problems.push(`README.zh-CN.md 引用的图片不存在：${img}`);
if (imgs.length < 1) problems.push('README.md 未引用任何 assets 图片');

/* ③ CLI 默认值覆盖：从脚本里抽出默认值，逐个在 README 中出现 */
const cap = read('scripts/capture.js'), dif = read('scripts/diff.js');
const defaults = [
  [/opt\('viewport', '([^']+)'\)/.exec(cap)[1], 'capture --viewport'],
  [/opt\('max-screens', '([^']+)'\)/.exec(cap)[1], 'capture --max-screens'],
  [/opt\('timeout', '([^']+)'\)/.exec(cap)[1], 'capture --timeout'],
  [/opt\('threshold', '([^']+)'\)/.exec(dif)[1], 'diff --threshold'],
  [/opt\('block', '([^']+)'\)/.exec(dif)[1], 'diff --block'],
];
for (const [val, name] of defaults) {
  if (!en.includes(val) || !zh.includes(val)) problems.push(`README 未覆盖 ${name} 默认值 ${val}`);
}

/* ④ docs 成对 */
for (const base of ['cli-reference', 'output-schema']) {
  if (!exists(`docs/${base}.md`)) problems.push(`缺少 docs/${base}.md`);
  if (!exists(`docs/${base}.zh-CN.md`)) problems.push(`缺少 docs/${base}.zh-CN.md`);
}

/* ⑤ 仓库内链接存在 */
const links = [...(en + zh).matchAll(/\]\(((?!https?:)[^)#]+)\)/g)].map(m => m[1]);
for (const l of new Set(links)) {
  if (/^(mailto:|images\/)/.test(l)) continue;
  if (!exists(decodeURIComponent(l))) problems.push(`链接目标不存在：${l}`);
}

if (problems.length) {
  console.error('check-docs 失败：');
  problems.forEach(p => console.error('  - ' + p));
  process.exit(1);
}
console.log(`  check-docs：OK（中英 README ${h2en} 节对等、${imgs.length} 张图存在、CLI 默认值全覆盖、docs 成对、链接可达）`);
