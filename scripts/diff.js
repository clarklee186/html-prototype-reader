#!/usr/bin/env node
/**
 * html-prototype-reader · diff
 * 「还原结果 vs 原型」验收：同视口截图像素对比 + 结构/样式/交互差异清单
 *
 * 用法:
 *   node diff.js <原型.html|URL> <还原.html|URL> <输出目录> [--viewport 1440x900] [--threshold 32] [--block 100]
 *
 * 产物:
 *   prototype.png / restored.png / diff-overlay.png（差异像素标红）
 *   diff-report.md（agent 首读）/ diff.json（全量数据）
 *
 * 依赖: playwright-core（零 npm 依赖，像素比对在浏览器 canvas 内完成）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadPlaywright() {
  try { return require('playwright-core'); } catch (e) { /* continue */ }
  const candidates = [
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright-core'),
    path.join(__dirname, '..', 'node_modules', 'playwright-core'),
    path.join(process.cwd(), 'node_modules', 'playwright-core'),
  ];
  for (const c of candidates) { try { return require(c); } catch (e) { /* next */ } }
  console.error('[html-prototype-reader] 找不到 playwright-core。请安装任一处：npm i playwright-core（或设 NODE_PATH 指向已安装目录）');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const argv = process.argv.slice(2);
const protoArg = argv[0], restArg = argv[1], outDir = argv[2];
if (!protoArg || !restArg || !outDir) { console.error('用法: node diff.js <原型> <还原> <输出目录> [--viewport 1440x900] [--threshold 32] [--block 100]'); process.exit(1); }
function opt(name, def) { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; }
const [VP_W, VP_H] = String(opt('viewport', '1440x900')).split('x').map(Number);
const THRESHOLD = parseInt(opt('threshold', '32'), 10);
const BLOCK = parseInt(opt('block', '100'), 10);
fs.mkdirSync(outDir, { recursive: true });
const OUT = path.resolve(outDir); // 后续全部用绝对路径，避免相对路径在 file:// 下解析错误

const toUrl = p => /^https?:\/\//.test(p) ? p : 'file:///' + path.resolve(p).replace(/\\/g, '/');
const PROTO_URL = toUrl(protoArg), REST_URL = toUrl(restArg);

/* 冻结动画/过渡与启动参数：与 capture.js 共用共享模块，避免两侧基准漂移 */
const { FREEZE_CSS, DIFF_PROPS, LAUNCH_ARGS } = require('./shared');

/* 页内快照：结构 + 类样式样本 + 文本 + 交互元素 + 分区 */
const SNAPSHOT_FN = `(() => {
  const visible = el => { const st = getComputedStyle(el); const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden'; };
  const clsOf = el => (typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean) : []);
  const els = Array.from(document.body.querySelectorAll('*')).filter(visible);
  const tagCounts = {}; const classCount = {};
  const texts = []; const interactives = [];
  for (const el of els) {
    tagCounts[el.tagName] = (tagCounts[el.tagName] || 0) + 1;
    for (const c of clsOf(el)) classCount[c] = (classCount[c] || 0) + 1;
    if (!el.children.length) { const t = (el.textContent || '').replace(/\\s+/g, ' ').trim(); if (t.length > 1) texts.push(t.slice(0, 80)); }
    const t = el.tagName; const role = el.getAttribute('role') || '';
    if (['BUTTON','INPUT','SELECT','TEXTAREA','A','LABEL'].includes(t) || /button|tab|switch|checkbox|radio|combobox/.test(role)) {
      interactives.push({ tag: t.toLowerCase(), text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30) || undefined, type: el.getAttribute('type') || undefined, role: role || undefined });
    }
  }
  // 类样式样本（按出现频次取前 250 类，各自首个可见匹配）
  const PROPS = JSON.parse('%DIFF_PROPS%');
  const topCls = Object.entries(classCount).sort((a, b) => b[1] - a[1]).slice(0, 250).map(e => e[0]);
  const classStyles = {};
  for (const c of topCls) {
    let el = null;
    try { el = document.querySelector('.' + (window.CSS && CSS.escape ? CSS.escape(c) : c)); } catch (e) { continue; }
    if (!el || !visible(el)) continue;
    const st = getComputedStyle(el); const m = {};
    for (const p of PROPS) m[p] = String(st[p] || '').replace(/\\s+/g, ' ');
    classStyles[c] = m;
  }
  // 分区：body 顶层子块 + 标题
  const sections = [];
  for (const el of document.body.children) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    sections.push({ label: (el.id ? '#' + el.id : '') || clsOf(el).slice(0, 2).join('.') || el.tagName.toLowerCase(), y0: Math.round(r.y + window.scrollY), y1: Math.round(r.y + window.scrollY + r.height) });
  }
  for (const h of document.querySelectorAll('h1,h2,h3')) {
    if (!visible(h)) continue;
    const r = h.getBoundingClientRect();
    sections.push({ label: (h.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24) || h.tagName, y0: Math.round(r.y + window.scrollY), y1: Math.round(r.y + window.scrollY + r.height), heading: true });
  }
  sections.sort((a, b) => a.y0 - b.y0);
  return {
    height: document.body.scrollHeight, width: document.body.scrollWidth,
    title: document.title, elementCount: els.length,
    tagCounts, classCount, classStyles, texts: texts.slice(0, 1500),
    interactives, sections,
  };
})()`;

/* 页内像素对比：canvas 读两张 PNG，逐像素阈值比对，输出 diff 覆盖层
   注意：必须传真实函数对象（Playwright 对"字符串函数表达式 + 解构参数"会按表达式求值返回 undefined） */
async function COMPARE_FN({ aUrl, bUrl, T, BLOCK }) {
  const load = src => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('img load fail: ' + src)); im.src = src; });
  const imgA = await load(aUrl); const imgB = await load(bUrl);
  const W = Math.min(imgA.width, imgB.width), H = Math.min(imgA.height, imgB.height);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(imgA, 0, 0); const A = cx.getImageData(0, 0, W, H).data;
  cx.clearRect(0, 0, W, H); cx.drawImage(imgB, 0, 0); const B = cx.getImageData(0, 0, W, H).data;
  const out = cx.createImageData(W, H); out.data.set(A);
  const blocks = new Map(); let diff = 0;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = (row + x) * 4;
      const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
      if (d > T) {
        diff++;
        const k = ((x / BLOCK) | 0) + ':' + ((y / BLOCK) | 0);
        blocks.set(k, (blocks.get(k) || 0) + 1);
        out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 64; out.data[i + 3] = 220;
      }
    }
  }
  cx.putImageData(out, 0, 0);
  return {
    W, H, aW: imgA.width, aH: imgA.height, bW: imgB.width, bH: imgB.height,
    diffPixels: diff, ratio: diff / (W * H),
    blocks: Array.from(blocks, ([k, n]) => { const [bx, by] = k.split(':').map(Number); return { bx, by, n, ratio: n / (BLOCK * BLOCK) }; }),
    diffDataUrl: cv.toDataURL('image/png'),
  };
}

(async () => {
  const started = Date.now();
  let browser = null, channelUsed = null;
  for (const channel of ['chrome', 'msedge', undefined]) {
    try {
      browser = await chromium.launch(channel ? { channel, headless: true, args: LAUNCH_ARGS } : { headless: true, args: LAUNCH_ARGS });
      channelUsed = channel || 'bundled-chromium'; break;
    } catch (e) { /* next */ }
  }
  if (!browser) { console.error('无法启动浏览器'); process.exit(3); }

  const failedReqs = [];
  async function loadAndShoot(url, shotPath, label) {
    const page = await browser.newPage({ viewport: { width: VP_W, height: VP_H } });
    page.on('requestfailed', r => failedReqs.push({ side: label, url: r.url().slice(0, 180), err: r.failure() && r.failure().errorText }));
    page.on('response', r => { if (r.status() >= 400) failedReqs.push({ side: label, url: r.url().slice(0, 180), err: 'HTTP ' + r.status() }); });
    try { await page.goto(url, { waitUntil: 'load', timeout: 45000 }); } catch (e) { await page.close(); throw new Error(label + ' 加载失败: ' + String(e).slice(0, 120)); }
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch (e) { /* */ }
    await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
    await page.evaluate(() => { const RealIO = window.IntersectionObserver; if (RealIO) window.IntersectionObserver = class extends RealIO { constructor(cb, o) { super(cb, o); setTimeout(() => { try { cb([{ isIntersecting: true, target: document.body }], this); } catch (e) {} }, 0); } }; document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; }); }).catch(() => {});
    await page.evaluate(async () => { await new Promise(res => { let y = 0; const t = setInterval(() => { y += 800; window.scrollTo(0, y); if (y >= (document.body ? document.body.scrollHeight : 0)) { clearInterval(t); window.scrollTo(0, 0); res(); } }, 35); }); }).catch(() => {});
    await page.waitForTimeout(400);
    const snapshot = await page.evaluate(SNAPSHOT_FN.replace('%DIFF_PROPS%', JSON.stringify(DIFF_PROPS))).catch(e => ({ error: String(e).slice(0, 120) }));
    await page.screenshot({ path: shotPath, fullPage: true });
    await page.close();
    return snapshot;
  }

  const shotA = path.join(OUT, 'prototype.png');
  const shotB = path.join(OUT, 'restored.png');
  const snapA = await loadAndShoot(PROTO_URL, shotA, 'prototype');
  const snapB = await loadAndShoot(REST_URL, shotB, 'restored');

  // 像素对比（在 file:// 源上执行 canvas 读取，已加 --allow-file-access-from-files）
  const cmpPage = await browser.newPage({ viewport: { width: VP_W, height: VP_H } });
  await cmpPage.goto('file:///' + shotA.replace(/\\/g, '/'), { waitUntil: 'load' });
  const cmp = await cmpPage.evaluate(COMPARE_FN, { aUrl: 'file:///' + shotA.replace(/\\/g, '/'), bUrl: 'file:///' + shotB.replace(/\\/g, '/'), T: THRESHOLD, BLOCK });
  // diff 覆盖层落盘
  const b64 = cmp.diffDataUrl.split(',')[1];
  fs.writeFileSync(path.join(OUT, 'diff-overlay.png'), Buffer.from(b64, 'base64'));
  await cmpPage.close();
  await browser.close();

  /* ===== 结构差异（Node 侧） ===== */
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const clsA = snapA.classCount || {}, clsB = snapB.classCount || {};
  const missingClasses = Object.keys(clsA).filter(c => !clsB[c]).sort((a, b) => clsA[b] - clsA[a]);
  const extraClasses = Object.keys(clsB).filter(c => !clsA[c]).sort((a, b) => clsB[b] - clsB[a]);
  const shared = Object.keys(clsA).filter(c => clsB[c]);
  const styleMismatches = [];
  for (const c of shared) {
    const sa = (snapA.classStyles || {})[c], sb = (snapB.classStyles || {})[c];
    if (!sa || !sb) continue;
    for (const p of Object.keys(sa)) {
      if (norm(sa[p]) !== norm(sb[p])) styleMismatches.push({ cls: c, prop: p, prototype: norm(sa[p]).slice(0, 70), restored: norm(sb[p]).slice(0, 70) });
    }
  }
  styleMismatches.sort((a, b) => (clsA[b.cls] || 0) - (clsA[a.cls] || 0));
  const setT = arr => new Set(arr.map(norm));
  const textsA = setT(snapA.texts || []), textsB = setT(snapB.texts || []);
  const missingTexts = [...textsA].filter(t => !textsB.has(t));
  const extraTexts = [...textsB].filter(t => !textsA.has(t));
  const labelOf = i => (i.tag || '') + (i.text ? '·' + i.text : '');
  const interA = new Set((snapA.interactives || []).map(labelOf));
  const interB = new Set((snapB.interactives || []).map(labelOf));
  const missingInter = [...interA].filter(x => !interB.has(x));
  const extraInter = [...interB].filter(x => !interA.has(x));

  // 热区 → 原型分区标注：优先取 y 之上最近的一个标题（文档大纲），否则回落到包含 y 的最小容器
  const sections = (snapA.sections || []).filter(s => Number.isFinite(s.y0));
  const headings = sections.filter(s => s.heading).sort((a, b) => a.y0 - b.y0);
  const containers = sections.filter(s => !s.heading);
  const labelAt = y => {
    let outline = null;
    for (const h of headings) { if (h.y0 <= y) outline = h.label; else break; }
    if (outline) return outline;
    const containing = containers.filter(s => y >= s.y0 && y < (s.y1 || s.y0 + 99999));
    if (containing.length) return containing.reduce((a, b) => ((b.y1 - b.y0) < (a.y1 - a.y0) ? b : a)).label;
    let best = null, dist = Infinity;
    for (const s of containers) { const d = Math.abs(y - s.y0); if (d < dist) { dist = d; best = s.label; } }
    return best || '?';
  };
  const hotspots = (cmp.blocks || []).map(b => ({ yCenter: b.by * BLOCK + BLOCK / 2, xCenter: b.bx * BLOCK + BLOCK / 2, ...b, section: labelAt(b.by * BLOCK + BLOCK / 2) }))
    .sort((a, b) => b.n - a.n).slice(0, 12);

  const result = {
    generatedAt: new Date().toISOString(), tool: 'html-prototype-reader/diff',
    viewport: `${VP_W}x${VP_H}`, threshold: THRESHOLD, block: BLOCK,
    prototype: { input: protoArg, title: snapA.title, height: snapA.height, elementCount: snapA.elementCount },
    restored: { input: restArg, title: snapB.title, height: snapB.height, elementCount: snapB.elementCount },
    pixel: { width: cmp.W, height: cmp.H, comparedW: cmp.W, comparedH: cmp.H, protoSize: [cmp.aW, cmp.aH], restoredSize: [cmp.bW, cmp.bH], sizeMismatch: cmp.aW !== cmp.bW || cmp.aH !== cmp.bH, diffPixels: cmp.diffPixels, ratio: cmp.ratio, threshold: THRESHOLD },
    structure: {
      missingClasses: missingClasses.slice(0, 40).map(c => ({ cls: c, count: clsA[c] })), missingClassTotal: missingClasses.length,
      extraClasses: extraClasses.slice(0, 40).map(c => ({ cls: c, count: clsB[c] })), extraClassTotal: extraClasses.length,
      styleMismatches: styleMismatches.slice(0, 60), styleMismatchTotal: styleMismatches.length,
      missingTextCount: missingTexts.length, missingTexts: missingTexts.slice(0, 20),
      extraTextCount: extraTexts.length, extraTexts: extraTexts.slice(0, 20),
      interactive: { protoCount: interA.size, restoredCount: interB.size, missingCount: missingInter.length, missing: missingInter.slice(0, 15), extraCount: extraInter.length, extra: extraInter.slice(0, 15) },
      heightDelta: (snapB.height || 0) - (snapA.height || 0),
    },
    hotspots, failedRequests: failedReqs,
    elapsedSec: Math.round((Date.now() - started) / 1000),
  };
  fs.writeFileSync(path.join(OUT, 'diff.json'), JSON.stringify(result, null, 1));

  /* ===== diff-report.md ===== */
  const L = [];
  const pct = r => (r * 100).toFixed(2) + '%';
  L.push(`# 还原验收报告（html-prototype-reader/diff）`);
  L.push('');
  L.push(`- 原型：${protoArg}（${snapA.title || ''}，高 ${snapA.height}px / ${snapA.elementCount} 元素）`);
  L.push(`- 还原：${restArg}（${snapB.title || ''}，高 ${snapB.height}px / ${snapB.elementCount} 元素）`);
  L.push(`- 视口 ${VP_W}x${VP_H}，像素阈值 ${THRESHOLD}，耗时 ${result.elapsedSec}s`);
  L.push('');
  L.push(`## 总览`);
  L.push('');
  L.push(`| 维度 | 结果 |`);
  L.push(`|---|---|`);
  L.push(`| 像素差异率 | **${pct(cmp.ratio)}**（${cmp.diffPixels.toLocaleString()} px / ${(cmp.W * cmp.H).toLocaleString()} px） |`);
  L.push(`| 页面尺寸 | 原型 ${cmp.aW}×${cmp.aH} vs 还原 ${cmp.bW}×${cmp.bH}${result.pixel.sizeMismatch ? ' ⚠️ 尺寸不一致' : '（一致）'}；还原比原型${result.structure.heightDelta >= 0 ? '高' : '矮'} ${Math.abs(result.structure.heightDelta)}px |`);
  L.push(`| 结构缺失类 | ${missingClasses.length} 个 |`);
  L.push(`| 多余类 | ${extraClasses.length} 个 |`);
  L.push(`| 样式不一致 | **${styleMismatches.length} 项**（${new Set(styleMismatches.map(m => m.cls)).size} 个类） |`);
  L.push(`| 文本缺失 / 多余 | ${missingTexts.length} / ${extraTexts.length} |`);
  L.push(`| 交互元素 | 原型 ${interA.size} vs 还原 ${interB.size}，缺失 ${missingInter.length}、多余 ${extraInter.length} |`);
  L.push('');
  if (hotspots.length) {
    L.push(`## 差异热区（按差异像素数排序，区域按原型分区标注）`);
    L.push('');
    L.push(`| 位置 (x,y) | 区域 | 差异块占比 |`);
    L.push(`|---|---|---|`);
    for (const h of hotspots) L.push(`| (${h.xCenter}, ${h.yCenter}) | ${h.section} | ${pct(h.ratio)} |`);
    L.push('');
    L.push(`> 可视化：\`diff-overlay.png\`（差异像素标红），对照 \`prototype.png\` / \`restored.png\`。`);
    L.push('');
  }
  if (styleMismatches.length) {
    L.push(`## 样式不一致清单（按类出现频次排序，前 60）`);
    L.push('');
    L.push(`| 类 | 属性 | 原型 | 还原 |`);
    L.push(`|---|---|---|---|`);
    for (const m of styleMismatches.slice(0, 60)) L.push(`| ${m.cls} | ${m.prop} | \`${m.prototype}\` | \`${m.restored}\` |`);
    L.push('');
  }
  if (missingClasses.length) {
    L.push(`## 结构缺失类（原型有、还原无，前 40）`);
    L.push('');
    L.push(missingClasses.slice(0, 40).map(c => `\`${c}\`×${clsA[c]}`).join('、'));
    L.push('');
  }
  if (missingTexts.length) {
    L.push(`## 缺失文本样例（前 20）`);
    L.push('');
    for (const t of missingTexts.slice(0, 20)) L.push(`- ${t}`);
    L.push('');
  }
  if (missingInter.length) {
    L.push(`## 缺失交互元素样例（前 15）`);
    L.push('');
    for (const t of missingInter.slice(0, 15)) L.push(`- ${t}`);
    L.push('');
  }
  if (failedReqs.length) { L.push(`## 资源加载失败`); for (const r of failedReqs.slice(0, 15)) L.push(`- [${r.side}] ${r.err} — ${r.url}`); L.push(''); }
  L.push(`## 判读提示`);
  L.push('');
  L.push(`- 像素差异率 <1% 且无样式不一致 → 可视为一致；1–5% 先看热区是否集中在动效/图标；>5% 按热区逐区修复。`);
  L.push(`- 本报告对比的是两边的**初始渲染态**；多屏原型请用 capture.js 逐屏参考，并对每个屏的还原结果分别跑 diff。`);
  L.push(`- 动画已冻结（animation-paused + transition:none），截图差异不包含动效时序。`);
  fs.writeFileSync(path.join(OUT, 'diff-report.md'), L.join('\n'));

  console.log(JSON.stringify({
    ok: true, outDir, ratio: +cmp.ratio.toFixed(4),
    styleMismatchTotal: styleMismatches.length, missingClassTotal: missingClasses.length, extraClassTotal: extraClasses.length,
    missingTextCount: missingTexts.length, extraTextCount: extraTexts.length,
    interactive: result.structure.interactive.protoCount + '->' + result.structure.interactive.restoredCount,
    sizeMismatch: result.pixel.sizeMismatch, heightDelta: result.structure.heightDelta,
    failedRequests: failedReqs.length, elapsedSec: result.elapsedSec,
  }, null, 2));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
