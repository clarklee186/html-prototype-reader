#!/usr/bin/env node
/**
 * html-prototype-reader · capture
 * 渲染式 HTML 原型捕获：extract(渲染提取) + traverse(交互遍历) + compress(压缩) + output(落盘)
 *
 * 用法:
 *   node capture.js <html文件或目录> <输出目录> [--viewport 1440x900] [--max-screens 30] [--timeout 45000]
 *
 * 依赖: playwright-core（自动尝试本机 Chrome/Edge，无需下载浏览器）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { STYLE_PROPS, ALWAYS_KEEP: ALWAYS_KEEP_ARR, FREEZE_CSS, LAUNCH_ARGS, IFRAME_DEPTH_LIMIT, TUNING, SCHEMA_VERSION } = require('./shared');
const { inPageLib } = require('./inpage-lib');

/* ---------- playwright-core 解析（NODE_PATH → 用户级托管工作区 → 同级 node_modules） ---------- */
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

/* ---------- CLI ---------- */
const argv = process.argv.slice(2);
const inputArg = argv[0], outDir = argv[1];
if (!inputArg || !outDir) {
  console.error('用法: node capture.js <html文件或目录> <输出目录> [--viewport 1440x900] [--max-screens 30] [--timeout 45000] [--shot-format png|jpeg] [--no-network]');
  process.exit(1);
}
function opt(name, def) { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; }
const [VP_W, VP_H] = String(opt('viewport', '1440x900')).split('x').map(Number);
const MAX_SCREENS = parseInt(opt('max-screens', '30'), 10);
const PAGE_TIMEOUT = parseInt(opt('timeout', '45000'), 10);
const NO_NETWORK = argv.includes('--no-network');                       // 阻断外发（来源不可信时用）
const SHOT_FORMAT = String(opt('shot-format', 'png')).toLowerCase() === 'jpeg' ? 'jpeg' : 'png';
const JPEG_QUALITY = parseInt(opt('jpeg-quality', '82'), 10);
fs.mkdirSync(outDir, { recursive: true });

/* ---------- 降级记录（让"失败"与"本来就没有"可区分） ---------- */
const warnings = [];
function warn(page, stage, err) {
  const message = String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 160);
  warnings.push({ page, stage, message });
  if (process.env.DEBUG) console.error('[warn]', page, stage, message);
}

const absInput = path.resolve(inputArg);
const inputs = [];
if (fs.statSync(absInput).isDirectory()) {
  for (const f of fs.readdirSync(absInput).filter(f => /\.html?$/i.test(f)).sort()) inputs.push(path.join(absInput, f));
} else inputs.push(absInput);
if (!inputs.length) { console.error('未找到 HTML 文件'); process.exit(1); }

/* ---------- 常量（STYLE_PROPS / FREEZE_CSS 等见 shared.js，单一真理源） ---------- */
const ALWAYS_KEEP = new Set(ALWAYS_KEEP_ARR);
const LIB_GLOBAL = '__hprLib';

/* 页内库：整页只注入一次（此前每个 evaluate 都重注入，单屏 7 次） */
const libSrc = '(' + inPageLib.toString()
  .replace('%STYLE_PROPS_JSON%', JSON.stringify(STYLE_PROPS))
  .replace('%ALWAYS_KEEP_JSON%', JSON.stringify([...ALWAYS_KEEP]))
  .replace('%IFRAME_DEPTH%', String(IFRAME_DEPTH_LIMIT))
  .replace('%TUNING_JSON%', JSON.stringify(TUNING)) + ')()';

async function ensureLib(page) {
  const ok = await page.evaluate(`(() => { if (window.${LIB_GLOBAL}) return true; window.${LIB_GLOBAL} = ${libSrc}; return true; })()`);
  if (!ok) throw new Error('页内库注入失败');
  return true;
}

/** 调用页内库：注入一次 + 失败重注入重试一次（入口点击可能触发整页导航） */
async function callLib(page, expr, fallback, pageName) {
  await ensureLib(page);
  try { return await page.evaluate(`window.${LIB_GLOBAL}.${expr}`); }
  catch (e) {
    try { await ensureLib(page); return await page.evaluate(`window.${LIB_GLOBAL}.${expr}`); }
    catch (e2) { warn(pageName, 'lib:' + expr.slice(0, 24), e2); return typeof fallback === 'function' ? fallback() : fallback; }
  }
}

/* ---------- 主流程 ---------- */
(async () => {
  const started = Date.now();
  let browser = null;
  try {
  // 启动浏览器：chrome → msedge → 默认
  let channelUsed = null;
  for (const channel of ['chrome', 'msedge', undefined]) {
    try { browser = await chromium.launch(channel ? { channel, headless: true, args: LAUNCH_ARGS } : { headless: true, args: LAUNCH_ARGS }); channelUsed = channel || 'bundled-chromium'; break; } catch (e) { /* next */ }
  }
  if (!browser) { console.error('无法启动浏览器（chrome/msedge 均失败）'); process.exitCode = 3; return; }

  const pages = [];
  const failedReqs = [];

  for (const file of inputs) {
    const page = await browser.newPage({ viewport: { width: VP_W, height: VP_H } });
    const base = path.basename(file);
    const extHosts = new Set();
    const isLocal = u => /^(file|data|blob):/i.test(u) || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(u);
    page.on('request', r => {
      const u = r.url();
      if (!isLocal(u)) { try { extHosts.add(new URL(u).host); } catch (e) { extHosts.add(u.slice(0, 40)); } }
    });
    if (NO_NETWORK) {
      await page.route('**', route => isLocal(route.request().url()) ? route.continue() : route.abort())
        .catch(e => warn(base, 'no-network', e));
    }
    page.on('requestfailed', r => failedReqs.push({ page: path.basename(file), url: r.url().slice(0, 180), err: r.failure() && r.failure().errorText }));
    page.on('response', r => { if (r.status() >= 400) failedReqs.push({ page: path.basename(file), url: r.url().slice(0, 180), err: 'HTTP ' + r.status() }); });

    const fileUrl = 'file:///' + file.replace(/\\/g, '/');
    try { await page.goto(fileUrl, { waitUntil: 'load', timeout: PAGE_TIMEOUT }); } catch (e) { pages.push({ file: path.basename(file), error: 'goto: ' + String(e).slice(0, 120) }); await page.close(); continue; }
    try { await page.waitForLoadState('networkidle', { timeout: TUNING.networkIdleMs }); } catch (e) { /* 网络长连接容错 */ }

    // 冻结动画/过渡：保证分屏截图可复现（与 diff.js 用同一份 FREEZE_CSS，否则两侧基准会漂移）
    await page.addStyleTag({ content: FREEZE_CSS }).catch(e => warn(base, 'freeze-css', e));

    // 反懒加载 + 全页滚动
    await page.evaluate(() => {
      const RealIO = window.IntersectionObserver;
      if (RealIO) window.IntersectionObserver = class extends RealIO {
        constructor(cb, opts) { super(cb, opts); setTimeout(() => { try { cb([{ isIntersecting: true, target: document.body }], this); } catch (e) {} }, 0); }
      };
      document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; });
    }).catch(e => warn(base, 'anti-lazy', e));
    await page.evaluate(async ({ step, interval }) => {
      await new Promise(res => { let y = 0; const t = setInterval(() => { y += step; window.scrollTo(0, y); if (y >= (document.body ? document.body.scrollHeight : 0)) { clearInterval(t); window.scrollTo(0, 0); res(); } }, interval); });
    }, { step: TUNING.scrollStepPx, interval: TUNING.scrollIntervalMs }).catch(e => warn(base, 'scroll', e));
    await page.waitForTimeout(TUNING.settleAfterLoadMs);

    // CSS 统计 + 覆盖层清单 + 初始树
    const css = await callLib(page, 'cssStats()', () => ({ error: 'cssStats failed' }), base);
    const overlays = await callLib(page, 'overlayInventory()', () => [], base);

    // 主题态探测
    const theme = await page.evaluate(`(() => {
      const btn = document.querySelector('[class*="theme"],[aria-label*="theme" i],[title*="theme" i]');
      if (!btn) return { toggles: [] };
      const probe = () => { const o = {}; for (const sel of ['body','.sidebar','.card','header','nav']) { const el = document.querySelector(sel); if (el) { const st = getComputedStyle(el); o[sel] = { bg: st.backgroundColor, color: st.color }; } } return o; };
      const before = probe();
      const states = [];
      try { btn.click(); } catch(e) {}
      return new Promise(res => setTimeout(() => {
        const after = probe();
        states.push({ name: 'toggled', bodyClasses: document.body.className.slice(0, 80), probe: after });
        try { btn.click(); } catch(e) {}
        setTimeout(() => res({ toggles: states, before, toggleFound: true, toggleEl: (typeof btn.className==='string'?btn.className:'') }), 120);
      }, 150));
    })()`).catch(() => ({ toggles: [] }));

    // ===== traverse：入口发现 + 逐个点击 + 签名去重 =====
    const screens = [];
    const seenSig = new Set();
    const screenTokenAccum = []; // dead-content 分析用：各屏的标签/类/id/属性串
    async function captureScreen(name, entryText) {
      await ensureLib(page);
      const info = await page.evaluate(`(() => {
        const lib = window.${LIB_GLOBAL};
        const vis = lib.visibleEls(document.body);
        const sigParts = vis.map(el => el.tagName + '.' + (typeof el.className === 'string' ? el.className : '')).sort();
        // 轻量签名：元素+类多重集的哈希
        let h = 0; const s = sigParts.join('|');
        for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
        const heading = document.querySelector('h1,h2,h3');
        // dead-content 分析用的 token 集（标签/类/id）与全部属性串（可达性启发式）
        const tags = new Set(), classes = new Set(), ids = new Set(); let attrsText = '';
        for (const el of vis) {
          tags.add(el.tagName.toLowerCase());
          if (el.id) ids.add(el.id);
          if (typeof el.className === 'string') for (const c of el.className.trim().split(/\\s+/)) if (c) classes.add(c);
          for (const a of el.attributes) attrsText += ' ' + a.name + '=' + a.value;
        }
        return {
          sig: String(h), count: vis.length,
          heading: heading ? heading.textContent.replace(/\\s+/g,' ').trim().slice(0, 40) : '',
          tokens: { tags: [...tags], classes: [...classes], ids: [...ids] },
          attrsText: attrsText.slice(0, 400000),
        };
      })()`).catch(() => null);
      if (!info) return null;
      if (seenSig.has(info.sig)) return { dup: true };
      seenSig.add(info.sig);
      if (info.tokens) screenTokenAccum.push({ tokens: info.tokens, attrsText: info.attrsText });
      const tree = await callLib(page, 'buildTree(document.body, null, 0)', () => null, base);
      const interactions = await callLib(page, 'interactiveList()', () => [], base);
      const shot = `screen-${String(screens.length).padStart(2, '0')}.${SHOT_FORMAT === 'jpeg' ? 'jpg' : 'png'}`;
      await page.screenshot({
        path: path.join(outDir, shot), type: SHOT_FORMAT,
        quality: SHOT_FORMAT === 'jpeg' ? JPEG_QUALITY : undefined,
      }).catch(e => warn(base, 'screenshot:' + shot, e));
      return { name, entry: entryText, heading: info.heading, elementCount: info.count, sig: info.sig, shot, tree, interactions };
    }

    // 初始屏
    const s0 = await captureScreen('initial', null);
    if (s0 && !s0.dup) screens.push(s0); else if (s0) screens.push({ ...s0, note: '与后续屏幕签名重复' });

    // 入口收集与点击句柄使用同一选择器，保证索引对齐
    const ENTRY_SEL = '.nav-item, [role="tab"], [data-view], [data-screen], [data-page], [class*="nav-item"], nav a[href^="#"]';
    const entryTexts = await page.evaluate(`(() => {
      return Array.from(document.querySelectorAll('${ENTRY_SEL}')).map(el => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24));
    })()`).catch(() => []);
    const entriesFound = entryTexts.length;
    let entriesClicked = 0;
    for (let i = 0; i < entryTexts.length; i++) {
      if (screens.length >= MAX_SCREENS) break;
      // 关键：每次点击前重新查询句柄 —— 导航点击常导致整棵 DOM 重建，预取句柄会失效
      // 每次点击前重新查询句柄：同选择器重复查询结果相同，重试无意义（旧实现的 for 循环已删除）
      const fresh = await page.$$(ENTRY_SEL).catch(e => { warn(base, 'entry-query', e); return []; });
      const handle = fresh[i] || null;
      if (!handle) continue;
      try { await handle.click({ timeout: TUNING.clickTimeoutMs }); } catch (err) { warn(base, 'entry-click', err); continue; }
      entriesClicked++;
      await page.waitForTimeout(TUNING.clickSettleMs);
      const sc = await captureScreen(entryTexts[i] || ('entry-' + i), entryTexts[i]);
      if (process.env.DEBUG) console.error('[entry]', i, JSON.stringify(entryTexts[i]), '->', sc ? (sc.dup ? 'DUP' : 'PUSH ' + sc.elementCount + ' ' + (sc.heading || '')) : 'NULL');
      if (sc && !sc.dup) screens.push(sc);
    }

    // ===== dead-content：汇总各屏 token 并集，识别死 CSS / 重复 id / 版本残留 / 隐藏分支 =====
    let deadContent = null;
    if (screenTokenAccum.length) {
      const tags = new Set(), classes = new Set(), ids = new Set(); let attrsText = '';
      for (const st of screenTokenAccum) {
        st.tokens.tags.forEach(t => tags.add(t));
        st.tokens.classes.forEach(c => classes.add(c));
        st.tokens.ids.forEach(i => ids.add(i));
        attrsText += ' ' + st.attrsText;
      }
      const union = { tags: [...tags], classes: [...classes], ids: [...ids], attrsText: attrsText.slice(0, TUNING.attrsTextLimit) };
      deadContent = await callLib(page, 'deadContent(' + JSON.stringify(union) + ')', () => ({ error: 'deadContent failed' }), base);
    }

    // ===== 汇总该页 =====
    const meta = await page.evaluate(() => ({
      title: document.title, url: location.href,
      totalElements: document.querySelectorAll('*').length,
      pageHeight: document.body ? document.body.scrollHeight : 0,
      fonts: document.fonts ? document.fonts.size : -1,
      stylesheets: document.styleSheets.length,
    })).catch(() => ({}));

    // iframe 递归结果汇总（同源已递归，跨域只留 src）
    const iframeStats = { total: 0, sameOriginRecursed: 0, crossOriginOrBlocked: 0 };
    const walkIframes = n => {
      if (!n) return;
      if (n.iframe) { iframeStats.total++; if (n.iframe.sameOrigin) iframeStats.sameOriginRecursed++; else iframeStats.crossOriginOrBlocked++; }
      (n.ch || []).forEach(walkIframes);
      if (n.iframe && n.iframe.content) walkIframes(n.iframe.content);
    };
    screens.forEach(s => walkIframes(s.tree));

    pages.push({
      file: base, ...meta, channel: channelUsed,
      screens, overlays, css, theme,
      entriesFound, entriesClicked, iframes: iframeStats,
      deadContent,
      externalHosts: [...extHosts],
      warnings: warnings.filter(w => w.page === base),
      themeToggled: !!theme.toggleFound,
    });
    await page.close();
  }

  /* ===== output ===== */
  const result = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    tool: 'html-prototype-reader/capture',
    viewport: `${VP_W}x${VP_H}`,
    inputs: inputs.map(i => path.basename(i)),
    fileComposition: null,
    pages, failedRequests: failedReqs,
    warnings,
    options: { viewport: `${VP_W}x${VP_H}`, maxScreens: MAX_SCREENS, timeoutMs: PAGE_TIMEOUT, shotFormat: SHOT_FORMAT, noNetwork: NO_NETWORK },
    elapsedSec: Math.round((Date.now() - started) / 1000),
  };

  // 文件构成（裸读通道对照）
  let totalBytes = 0, styleBytes = 0, scriptBytes = 0;
  for (const f of inputs) {
    const src = fs.readFileSync(f, 'utf8'); totalBytes += Buffer.byteLength(src);
    styleBytes += (src.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).reduce((n, s) => n + Buffer.byteLength(s), 0);
    scriptBytes += (src.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || []).reduce((n, s) => n + Buffer.byteLength(s), 0);
  }
  result.fileComposition = { bytes: totalBytes, estTokens: Math.round(totalBytes / 3.5), styleBytes, scriptBytes, markupBytes: Math.max(0, totalBytes - styleBytes - scriptBytes) };

  fs.writeFileSync(path.join(outDir, 'prototype.json'), JSON.stringify(result, null, 1));

  // summary.md（agent 首读入口）
  const L = [];
  L.push(`# 原型捕获摘要（html-prototype-reader）`);
  L.push('');
  if (warnings.length) {
    L.push(`> ⚠️ 本次抓取有 ${warnings.length} 处降级（下方产物对应字段可能缺失，勿当成"本来就没有"）：`);
    for (const w of warnings.slice(0, 8)) L.push(`> - [${w.page} · ${w.stage}] ${w.message}`);
    if (warnings.length > 8) L.push(`> - …共 ${warnings.length} 处，完整清单见 prototype.json 的 warnings`);
    L.push('');
  }
  L.push(`- 输入：${result.inputs.join(', ')}　视口：${result.viewport}　耗时：${result.elapsedSec}s`);
  L.push(`- 文件构成：总计 ${(totalBytes / 1024).toFixed(0)}KB（≈${result.fileComposition.estTokens.toLocaleString()} token）= 标记 ${(result.fileComposition.markupBytes / 1024).toFixed(1)}KB + CSS ${(styleBytes / 1024).toFixed(0)}KB + JS ${(scriptBytes / 1024).toFixed(0)}KB`);
  L.push('');
  for (const p of pages) {
    L.push(`## ${p.file} — ${p.title || ''}`);
    if (p.error) { L.push(`- ⚠️ 加载失败：${p.error}`); continue; }
    L.push(`- 屏幕：${p.screens.length} 个（${p.screens.map(s => `${s.name || s.heading || '?'}(${s.elementCount}元素)`).join('、')}）`);
    L.push(`- 交互遍历：发现入口 ${p.entriesFound ?? '-'} 个，成功点击 ${p.entriesClicked ?? '-'} 次，去重后得 ${p.screens.length} 屏${p.entriesFound > p.screens.length ? '（差额为签名重复或点击失败）' : ''}`);
    L.push(`- 覆盖层（弹窗/抽屉/Toast）：${(p.overlays || []).length} 个${(p.overlays || []).filter(o => o.hiddenNow).length ? `，其中 ${(p.overlays || []).filter(o => o.hiddenNow).length} 个当前隐藏（结构已在 prototype.json 中，触发后可见）` : ''}`);
    if (p.iframes && p.iframes.total) L.push(`- iframe：${p.iframes.total} 个，其中同源已递归 ${p.iframes.sameOriginRecursed} 个、跨域或不可访问 ${p.iframes.crossOriginOrBlocked} 个（只记 src）`);
    if (p.deadContent && !p.deadContent.error) {
      const dc = p.deadContent, c = dc.css || {};
      L.push(`- **多版本/死内容**：静态 CSS 规则 ${c.staticChecked ?? '?'} 条中，当前 DOM 命中 ${c.matchedNow ?? '?'} 条；休眠（token 在其他屏幕出现过，如 active 态）${c.dormantCount ?? 0} 条；**捕获中未出现** ${c.notSeenInCaptureCount ?? 0} 条——可能在未访问的屏幕、主题态或深层入口中激活，还原时不要实现`);
      L.push(`- 版本残留类名：${dc.versionResidueTotal} 个${dc.versionResidueClasses.length ? '（' + dc.versionResidueClasses.slice(0, 8).map(x => '`' + x + '`').join('、') + (dc.versionResidueTotal > 8 ? ' …' : '') + '）' : ''}；重复 id：${dc.duplicateIdTotal} 组`);
      L.push(`- 隐藏分支：${dc.hiddenBranchTotal} 个${dc.hiddenBranches.length ? '（' + dc.hiddenBranches.map(b => b.label + ' ' + b.subtreeElements + 'el' + (b.interactive ? '/' + b.interactive + '交互' : '')).join('、') + '）' : ''}——不可达的分支不在还原范围内`);
    }
    if (p.css && p.css.breakpoints) L.push(`- 响应式断点：${p.css.breakpoints.join(' / ')}px（@media 块 ${p.css.mediaConditions.length} 个）`);
    if (p.css) L.push(`- CSS 交互态：:hover ${p.css.hover} 条、:focus ${p.css.focus} 条、伪元素规则 ${p.css.pseudoRules} 条、@keyframes ${p.css.keyframes} 组；自定义属性定义 ${Object.keys(p.css.customPropsByState || {}).length} 处`);
    if (p.theme && p.theme.toggleFound) L.push(`- 主题切换：检测到，切换前后探针见 prototype.json（还原时两种状态都要覆盖）`);
    if (p.css && p.css.fontFaces && p.css.fontFaces.length) L.push(`- @font-face：${p.css.fontFaces.length} 组（${p.css.fontFaces.map(f => f.family).join('、')}）`);
    L.push(`- 资源加载失败：${failedReqs.filter(r => r.page === p.file).length} 项`);
    L.push('');
    L.push(`| 屏幕 | 元素数 | 交互元素 | 截图 |`);
    L.push(`|---|---|---|---|`);
    for (const s of p.screens) L.push(`| ${s.name || s.heading || '-'} | ${s.elementCount} | ${(s.interactions || []).length} | ${s.shot} |`);
    L.push('');
  }
  const extAll = [...new Set(pages.flatMap(p => p.externalHosts || []))];
  if (extAll.length) {
    L.push(`## 外部请求（安全提示）`);
    L.push(`- 原型向以下域发起过请求：${extAll.join('、')}${NO_NETWORK ? '（已由 --no-network 阻断）' : '——来源不可信时建议加 --no-network 运行'}`);
    L.push('');
  }
  if (failedReqs.length) { L.push(`## 资源加载失败清单`); for (const r of failedReqs.slice(0, 20)) L.push(`- ${r.page}: ${r.err} — ${r.url}`); }
  L.push('');
  L.push(`## 使用方式（给还原 agent）`);
  L.push(`1. 先看各屏截图建立视觉基准；2. 再读 prototype.json 中对应 screen 的 tree（组件树，含折叠 rep 标记与父级 diff 后的样式 s）；3. 交互元素逐条对照 interactions；4. 隐藏覆盖层结构在 overlays；5. 还原时覆盖全部断点与主题态。`);
  fs.writeFileSync(path.join(outDir, 'summary.md'), L.join('\n'));

  console.log(JSON.stringify({
    ok: true, outDir, pages: pages.length,
    screens: pages.reduce((n, p) => n + (p.screens ? p.screens.length : 0), 0),
    overlays: pages.reduce((n, p) => n + (p.overlays ? p.overlays.length : 0), 0),
    failedRequests: failedReqs.length, warnings: warnings.length, elapsedSec: result.elapsedSec,
  }, null, 2));
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* 关闭失败不覆盖原始错误 */ } }
  }
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
