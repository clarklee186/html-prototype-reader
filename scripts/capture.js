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
const { STYLE_PROPS, ALWAYS_KEEP: ALWAYS_KEEP_ARR, FREEZE_CSS, LAUNCH_ARGS, IFRAME_DEPTH_LIMIT } = require('./shared');

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
  console.error('用法: node capture.js <html文件或目录> <输出目录> [--viewport 1440x900] [--max-screens 30]');
  process.exit(1);
}
function opt(name, def) { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; }
const [VP_W, VP_H] = String(opt('viewport', '1440x900')).split('x').map(Number);
const MAX_SCREENS = parseInt(opt('max-screens', '30'), 10);
const PAGE_TIMEOUT = parseInt(opt('timeout', '45000'), 10);
fs.mkdirSync(outDir, { recursive: true });

const absInput = path.resolve(inputArg);
const inputs = [];
if (fs.statSync(absInput).isDirectory()) {
  for (const f of fs.readdirSync(absInput).filter(f => /\.html?$/i.test(f)).sort()) inputs.push(path.join(absInput, f));
} else inputs.push(absInput);
if (!inputs.length) { console.error('未找到 HTML 文件'); process.exit(1); }

/* ---------- 常量（STYLE_PROPS / FREEZE_CSS 等见 shared.js，单一真理源） ---------- */
const ALWAYS_KEEP = new Set(ALWAYS_KEEP_ARR);

/* ---------- 页内工具（注入浏览器执行） ---------- */
function inPageLib() {
  const STYLE_PROPS = JSON.parse('%STYLE_PROPS_JSON%');
  const ALWAYS_KEEP = new Set(JSON.parse('%ALWAYS_KEEP_JSON%'));
  const IFRAME_DEPTH_LIMIT = parseInt('%IFRAME_DEPTH%', 10);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'META', 'HEAD', 'BR']);

  const rounded = r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  const isVisible = el => {
    const st = getComputedStyle(el); const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const clsOf = el => (typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : []);
  const semOf = el => {
    const s = {};
    for (const a of ['role', 'aria-label', 'aria-hidden', 'aria-checked', 'aria-selected', 'aria-expanded', 'aria-pressed', 'aria-valuenow', 'aria-valuetext', 'aria-valuemin', 'aria-valuemax', 'aria-controls', 'alt', 'placeholder', 'name', 'type', 'href', 'title', 'for', 'action', 'contenteditable', 'list', 'accept', 'autocomplete', 'min', 'max', 'step', 'maxlength', 'pattern']) {
      const v = el.getAttribute && el.getAttribute(a); if (v != null && v !== '') s[a] = String(v).slice(0, 80);
    }
    if (el.disabled) s.disabled = true; if (el.required) s.required = true;
    // 状态属性：JS 设值不更新 attribute，必须读 property（checked/indeterminate/value/selected/open/multiple）
    try {
      const t = el.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') {
        if (typeof el.value === 'string' && el.value) s.value = el.value.replace(/\s+/g, ' ').slice(0, 120);
      }
      if (t === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        s.checked = !!el.checked;
        if (el.indeterminate) s.indeterminate = true;
      }
      if (t === 'OPTION') { if (el.selected) s.selected = true; }
      if (t === 'SELECT') {
        if (el.multiple) s.multiple = true;
        s.optionCount = el.options.length;
        s.options = Array.from(el.options).slice(0, 30).map(o => ({ v: o.value, t: (o.textContent || '').trim().slice(0, 40), sel: !!o.selected }));
      }
      if (t === 'DIALOG' || t === 'DETAILS') s.open = !!el.open;
      if (t === 'PROGRESS' || t === 'METER') { s.value = String(el.value); s.max = String(el.max); }
    } catch (e) { /* 非常规元素 */ }
    if (el.getAttribute && el.getAttribute('contenteditable') && el.textContent) {
      s.editableText = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    return s;
  };
  const pseudoOf = (el) => {
    const out = [];
    for (const p of ['::before', '::after']) {
      const st = getComputedStyle(el, p);
      if (st.content && st.content !== 'none' && st.content !== 'normal') {
        out.push({
          pseudo: p, content: st.content.slice(0, 40), position: st.position,
          decorative: st.content === '""' || st.content === "''",
          backgroundColor: st.backgroundColor !== 'rgba(0, 0, 0, 0)' ? st.backgroundColor : undefined,
          backgroundImage: st.backgroundImage !== 'none' ? st.backgroundImage.slice(0, 120) : undefined,
          width: st.width, height: st.height, borderRadius: st.borderRadius, zIndex: st.zIndex,
        });
      }
    }
    return out.length ? out : undefined;
  };
  const styleDiff = (el, parentMap) => {
    const st = getComputedStyle(el); const diff = {};
    for (const p of STYLE_PROPS) {
      const v = st[p]; if (v == null || v === '') continue;
      const parentV = parentMap ? parentMap[p] : undefined;
      if (ALWAYS_KEEP.has(p) || v !== parentV) {
        if (p === 'backgroundImage' && v === 'none') continue;
        if ((p === 'border' || p === 'borderTop' || p === 'borderRight' || p === 'borderBottom' || p === 'borderLeft') && /0px none|none/.test(v) && !parentV) continue;
        diff[p] = typeof v === 'string' ? v.slice(0, 120) : v;
      }
    }
    return Object.keys(diff).length ? diff : undefined;
  };
  const styleMap = el => { const st = getComputedStyle(el); const m = {}; for (const p of STYLE_PROPS) m[p] = st[p]; return m; };

  const textOf = el => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    t = t.replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, 100) : undefined;
  };

  function buildTree(el, parentMap, depth) {
    if (SKIP.has(el.tagName)) return null;
    const vis = isVisible(el);
    const node = { t: el.tagName.toLowerCase() };
    if (el.id) node.id = el.id;
    const cls = clsOf(el); if (cls.length) node.c = cls;
    const r = el.getBoundingClientRect();
    node.r = rounded(r); node.v = vis ? 1 : 0;
    // 离视口标记（off-canvas 抽屉等）：可见但在文档流范围之外
    if (vis) {
      try {
        const w = el.ownerDocument.defaultView;
        const docEl = el.ownerDocument.documentElement;
        const absX = r.x + (w ? w.scrollX : 0), absY = r.y + (w ? w.scrollY : 0);
        const cw = docEl ? docEl.clientWidth : 0, pageH = docEl ? Math.max(docEl.scrollHeight, document.body ? 0 : 0) : 0;
        if (absX >= cw || absX + r.width <= 0 || absY >= pageH || absY + r.height <= 0) node.offViewport = true;
      } catch (e) { /* 跨文档异常容忍 */ }
    }
    const map = styleMap(el);
    const sd = styleDiff(el, parentMap); if (sd) node.s = sd;
    const ps = pseudoOf(el); if (ps) node.ps = ps;
    const sem = semOf(el); if (Object.keys(sem).length) node.sem = sem;
    const tx = vis ? textOf(el) : undefined; if (tx) node.tx = tx;
    if (el.tagName === 'CANVAS') { node.canvas = { w: el.width, h: el.height }; }
    if (el.tagName === 'IMG') { node.img = { src: (el.getAttribute('src') || '').slice(0, 160), broken: el.complete && el.naturalWidth === 0 }; const ss = el.getAttribute('srcset'); if (ss) node.img.srcset = ss.slice(0, 160); }
    if (el.tagName === 'IFRAME') {
      node.iframe = { src: (el.src || '').slice(0, 160) };
      // 同源 iframe：递归提取内容（受 IFRAME_DEPTH_LIMIT 限制；跨域访问会抛异常，此时只保留 src）
      if (depth < IFRAME_DEPTH_LIMIT) {
        try {
          const doc = el.contentDocument;
          if (doc && doc.body) {
            node.iframe.sameOrigin = true;
            node.iframe.content = buildTree(doc.body, null, depth + 1);
          } else { node.iframe.sameOrigin = false; }
        } catch (e) { node.iframe.sameOrigin = false; node.iframe.blocked = true; }
      } else { node.iframe.depthSkipped = true; }
    }
    if (depth < 24 && el.children.length) {
      const kids = [];
      const sigs = [];
      for (const ch of el.children) {
        const sub = buildTree(ch, map, depth + 1);
        if (!sub) continue;
        kids.push(sub);
        sigs.push(JSON.stringify([sub.t, sub.c, sub.sigs, sub.tx]));
      }
      // 重复兄弟折叠：连续相同签名 → 保留首个 + rep:n
      const folded = [];
      let i = 0;
      while (i < kids.length) {
        let j = i + 1;
        while (j < kids.length && sigs[j] === sigs[i] && kids[i].t !== 'div' + '' /* 不折叠裸 div 对齐容器 */) {
          if (kids[i].t === 'li' || kids[i].t === 'tr' || kids[i].t === 'option' || (kids[i].c && kids[i].c.length) || kids[i].t === 'td' || kids[i].t === 'th') j++; else break;
        }
        if (j > i + 1) { kids[i].rep = j - i; folded.push(kids[i]); i = j; }
        else { folded.push(kids[i]); i++; }
      }
      if (folded.length) { node.ch = folded; node.sigs = sigs; }
    }
    return node;
  }

  function visibleEls(root) {
    return Array.from(root.querySelectorAll('*')).filter(isVisible);
  }

  function interactiveList() {
    const list = [];
    const vpW = document.documentElement ? document.documentElement.clientWidth : 0;
    const pageH = document.documentElement ? Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) : 0;
    const scrollX = window.scrollX, scrollY = window.scrollY;
    for (const el of visibleEls(document.body)) {
      const t = el.tagName;
      const role = el.getAttribute('role');
      const isInteractive = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A', 'LABEL', 'SUMMARY', 'DIALOG', 'DETAILS', 'OPTION', 'PROGRESS', 'METER'].includes(t)
        || (role && /button|tab|menuitem|link|switch|checkbox|radio|combobox|option|slider|searchbox|spinbutton/.test(role))
        || el.isContentEditable;
      if (!isInteractive) continue;
      const st = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const offViewport = (r.x + scrollX) >= vpW || (r.x + scrollX + r.width) <= 0 || (r.y + scrollY) >= pageH || (r.y + scrollY + r.height) <= 0;
      list.push({
        tag: t.toLowerCase(), cls: clsOf(el).slice(0, 3), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) || undefined,
        sem: semOf(el), rect: rounded(r), cursor: st.cursor, inOverlay: !!el.closest('[class*="modal"],[class*="dialog"],[class*="drawer"],[role="dialog"],dialog'), offViewport: offViewport || undefined,
      });
    }
    return list;
  }

  function cssStats() {
    const stats = { totalRules: 0, hover: 0, focus: 0, active: 0, pseudoRules: 0, keyframes: 0, mediaConditions: [], customPropsByState: {}, fontFaces: [] };
    const customPropRe = /^--/;
    function walk(rules, mediaText) {
      for (const r of rules) {
        stats.totalRules++;
        if (r.type === CSSRule.STYLE_RULE) {
          const sel = r.selectorText || '';
          if (/:hover/.test(sel)) stats.hover++;
          if (/:focus/.test(sel)) stats.focus++;
          if (/:active/.test(sel)) stats.active++;
          if (/::(before|after)/.test(sel)) stats.pseudoRules++;
          const props = Array.from(r.style || []).filter(p => customPropRe.test(p));
          if (props.length) {
            const key = mediaText ? `@media ${mediaText} → ${sel}` : sel;
            stats.customPropsByState[key] = stats.customPropsByState[key] || {};
            for (const p of props) stats.customPropsByState[key][p] = r.style.getPropertyValue(p).trim();
          }
          const ff = r.style.getPropertyValue('font-family'); if (ff) { /* noop, 字体在 fontFaces */ }
        } else if (r.type === CSSRule.MEDIA_RULE) { stats.mediaConditions.push(r.conditionText); walk(r.cssRules, r.conditionText); }
        else if (r.type === CSSRule.KEYFRAMES_RULE) stats.keyframes++;
        else if (r.type === CSSRule.FONT_FACE_RULE) stats.fontFaces.push({ family: r.style.getPropertyValue('font-family'), src: (r.style.getPropertyValue('src') || '').slice(0, 200), weight: r.style.getPropertyValue('font-weight') || undefined });
      }
    }
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules, null); } catch (e) { stats.sheetErrors = (stats.sheetErrors || 0) + 1; }
    }
    // 断点去重
    const bpSet = new Set();
    for (const c of stats.mediaConditions) { const m = c.match(/(\d+(?:\.\d+)?)px/g); if (m) m.forEach(x => bpSet.add(parseFloat(x))); }
    stats.breakpoints = Array.from(bpSet).map(Number).sort((a, b) => b - a);
    return stats;
  }

  function overlayInventory() {
    const out = [];
    const seen = new Set();
    for (const el of document.body.querySelectorAll('[class*="modal"],[class*="dialog"],[class*="drawer"],[class*="toast"],[class*="popover"],dialog,[role="dialog"]')) {
      if (seen.has(el)) continue; seen.add(el);
      const st = getComputedStyle(el); const r = el.getBoundingClientRect();
      out.push({
        cls: clsOf(el).join('.'), id: el.id || undefined, hiddenNow: !(r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden'),
        role: el.getAttribute('role') || undefined,
        tree: buildTree(el, el.parentElement ? styleMap(el.parentElement) : null, 0),
      });
    }
    return out;
  }

  /** dead-content：死 CSS / 重复 id / 版本残留类名 / 隐藏分支可达性 */
  function deadContent(union) {
    const out = {};
    const all = Array.from(document.querySelectorAll('*'));

    // 重复 id
    const idCount = {};
    all.forEach(el => { if (el.id) idCount[el.id] = (idCount[el.id] || 0) + 1; });
    out.duplicateIds = Object.entries(idCount).filter(([, n]) => n > 1).map(([id, n]) => ({ id, count: n })).slice(0, 20);
    out.duplicateIdTotal = out.duplicateIds.length;

    // 版本残留类名（-old / -v2 / -backup / copy / legacy / draft / tmp 等）
    const residueRe = /(^|[-_])(old|legacy|deprecated|backup|bak|copy|copied|draft|tmp|temp|test|v\d+)([-_]|$)/i;
    const classSeen = new Set(); const residue = new Set();
    all.forEach(el => {
      if (typeof el.className !== 'string') return;
      for (const c of el.className.trim().split(/\s+/)) {
        if (!c || classSeen.has(c)) continue; classSeen.add(c);
        if (residueRe.test(c)) residue.add(c);
      }
    });
    out.versionResidueClasses = [...residue].slice(0, 20);
    out.versionResidueTotal = residue.size;

    // 隐藏分支根：自身隐藏而父级可见的元素（排除 head/script/style 等天然不显示的标签）
    const NATURAL_HIDDEN = new Set(['HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE']);
    const isHidden = el => { const st = getComputedStyle(el); return st.display === 'none' || st.visibility === 'hidden'; };
    const branches = [];
    all.forEach(el => {
      if (NATURAL_HIDDEN.has(el.tagName)) return;
      if (!isHidden(el)) return;
      const parent = el.parentElement;
      if (parent && (isHidden(parent) || NATURAL_HIDDEN.has(parent.tagName))) return; // 只取分支根
      branches.push({
        label: el.id ? '#' + el.id : (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : el.tagName.toLowerCase()),
        subtreeElements: el.querySelectorAll('*').length + 1,
        interactive: el.querySelectorAll('button,input,select,textarea,a').length,
        tag: el.tagName.toLowerCase(),
      });
    });
    out.hiddenBranches = branches.slice(0, 20);
    out.hiddenBranchTotal = branches.length;

    // 死 CSS：静态选择器在当前 DOM 零匹配 → 按 token 是否在捕获过的屏幕中出现，分 dormant / unseen
    const tags = new Set(union.tags); const classes = new Set(union.classes); const ids = new Set(union.ids);
    const dormant = []; const unseen = []; let matchedNow = 0, staticChecked = 0, skipped = 0;
    const seen = new Set();
    const walk = rules => {
      for (const r of rules) {
        if (r.type === CSSRule.STYLE_RULE) {
          const selRaw = r.selectorText || '';
          if (!selRaw) continue;
          if (/:(hover|focus|focus-visible|active|visited|checked|disabled|enabled|before|after|placeholder|selection|first-line|first-letter|target|root)/.test(selRaw)
            || /::/.test(selRaw) || selRaw.includes('[') || selRaw.includes('*') || selRaw.includes(',')
            || /(:nth-|:not\(|:is\(|:has\(|:where\()/.test(selRaw)) { skipped++; continue; }
          const sel = selRaw.trim();
          if (!sel || seen.has(sel)) { skipped++; continue; }
          seen.add(sel); staticChecked++;
          try {
            if (document.querySelectorAll(sel).length > 0) { matchedNow++; continue; }
          } catch (e) { skipped++; continue; }
          // 零匹配 → 按 token 分类
          let allSeen = true;
          const tagTok = sel.match(/(^|[\s>~+])([a-zA-Z][\w-]*)/g) || [];
          for (const t of tagTok) { const tag = t.replace(/^[\s>~+]/, '').toLowerCase(); if (tag !== 'html' && tag !== 'body' && !tags.has(tag)) allSeen = false; }
          for (const m of sel.matchAll(/\.([\w-]+)/g)) if (!classes.has(m[1])) allSeen = false;
          for (const m of sel.matchAll(/#([\w-]+)/g)) if (!ids.has(m[1])) allSeen = false;
          (allSeen ? dormant : unseen).push(sel.slice(0, 80));
        } else if (r.cssRules) walk(r.cssRules);
      }
    };
    for (const s of document.styleSheets) { try { walk(s.cssRules); } catch (e) { /* 跨域 */ } }
    out.css = {
      staticChecked, matchedNow, skipped,
      dormantCount: dormant.length, dormantSamples: dormant.slice(0, 15),
      notSeenInCaptureCount: unseen.length, notSeenInCaptureSamples: unseen.slice(0, 15),
    };
    return out;
  }

  return { buildTree, visibleEls, interactiveList, cssStats, overlayInventory, styleMap, isVisible, deadContent };
}

/* ---------- 主流程 ---------- */
(async () => {
  const started = Date.now();
  // 启动浏览器：chrome → msedge → 默认
  let browser = null, channelUsed = null;
  for (const channel of ['chrome', 'msedge', undefined]) {
    try { browser = await chromium.launch(channel ? { channel, headless: true, args: LAUNCH_ARGS } : { headless: true, args: LAUNCH_ARGS }); channelUsed = channel || 'bundled-chromium'; break; } catch (e) { /* next */ }
  }
  if (!browser) { console.error('无法启动浏览器（chrome/msedge 均失败）'); process.exit(3); }

  const pages = [];
  const failedReqs = [];

  for (const file of inputs) {
    const page = await browser.newPage({ viewport: { width: VP_W, height: VP_H } });
    page.on('requestfailed', r => failedReqs.push({ page: path.basename(file), url: r.url().slice(0, 180), err: r.failure() && r.failure().errorText }));
    page.on('response', r => { if (r.status() >= 400) failedReqs.push({ page: path.basename(file), url: r.url().slice(0, 180), err: 'HTTP ' + r.status() }); });

    const fileUrl = 'file:///' + file.replace(/\\/g, '/');
    try { await page.goto(fileUrl, { waitUntil: 'load', timeout: PAGE_TIMEOUT }); } catch (e) { pages.push({ file: path.basename(file), error: 'goto: ' + String(e).slice(0, 120) }); await page.close(); continue; }
    try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch (e) { /* 网络长连接容错 */ }

    // 冻结动画/过渡：保证分屏截图可复现（与 diff.js 用同一份 FREEZE_CSS，否则两侧基准会漂移）
    await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});

    // 反懒加载 + 全页滚动
    await page.evaluate(() => {
      const RealIO = window.IntersectionObserver;
      if (RealIO) window.IntersectionObserver = class extends RealIO {
        constructor(cb, opts) { super(cb, opts); setTimeout(() => { try { cb([{ isIntersecting: true, target: document.body }], this); } catch (e) {} }, 0); }
      };
      document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; });
    }).catch(() => {});
    await page.evaluate(async () => {
      await new Promise(res => { let y = 0; const t = setInterval(() => { y += 800; window.scrollTo(0, y); if (y >= (document.body ? document.body.scrollHeight : 0)) { clearInterval(t); window.scrollTo(0, 0); res(); } }, 35); });
    }).catch(() => {});
    await page.waitForTimeout(400);

    const libSrc = '(' + inPageLib.toString()
      .replace('%STYLE_PROPS_JSON%', JSON.stringify(STYLE_PROPS))
      .replace('%ALWAYS_KEEP_JSON%', JSON.stringify([...ALWAYS_KEEP]))
      .replace('%IFRAME_DEPTH%', String(IFRAME_DEPTH_LIMIT)) + ')()';

    // CSS 统计 + 覆盖层清单 + 初始树
    const css = await page.evaluate(libSrc + '.cssStats()').catch(e => ({ error: String(e).slice(0, 100) }));
    const overlays = await page.evaluate(libSrc + '.overlayInventory()').catch(() => []);

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
      const info = await page.evaluate(`(() => {
        const lib = ${libSrc};
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
      const tree = await page.evaluate(`(() => {
        const lib = ${libSrc};
        const root = document.body;
        return lib.buildTree(root, null, 0);
      })()`).catch(() => null);
      const interactions = await page.evaluate(libSrc + '.interactiveList()').catch(() => []);
      const shot = `screen-${String(screens.length).padStart(2, '0')}.png`;
      await page.screenshot({ path: path.join(outDir, shot) }).catch(() => {});
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
      let handle = null;
      for (let attempt = 0; attempt < 2 && !handle; attempt++) {
        const fresh = await page.$$(ENTRY_SEL);
        handle = fresh[i] || null;
      }
      if (!handle) continue;
      try { await handle.click({ timeout: 2000 }); } catch (err) { if (process.env.DEBUG) console.error('[entry-click-fail]', i, String(err).slice(0, 80)); continue; }
      entriesClicked++;
      await page.waitForTimeout(320);
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
      const union = { tags: [...tags], classes: [...classes], ids: [...ids], attrsText: attrsText.slice(0, 400000) };
      deadContent = await page.evaluate(libSrc + '.deadContent(' + JSON.stringify(union) + ')').catch(e => ({ error: String(e).slice(0, 120) }));
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
      file: path.basename(file), ...meta, channel: channelUsed,
      screens, overlays, css, theme,
      entriesFound, entriesClicked, iframes: iframeStats,
      deadContent,
      themeToggled: !!theme.toggleFound,
    });
    await page.close();
  }
  await browser.close();

  /* ===== output ===== */
  const result = {
    generatedAt: new Date().toISOString(),
    tool: 'html-prototype-reader/capture',
    viewport: `${VP_W}x${VP_H}`,
    inputs: inputs.map(i => path.basename(i)),
    fileComposition: null,
    pages, failedRequests: failedReqs,
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
  if (failedReqs.length) { L.push(`## 资源加载失败清单`); for (const r of failedReqs.slice(0, 20)) L.push(`- ${r.page}: ${r.err} — ${r.url}`); }
  L.push('');
  L.push(`## 使用方式（给还原 agent）`);
  L.push(`1. 先看各屏截图建立视觉基准；2. 再读 prototype.json 中对应 screen 的 tree（组件树，含折叠 rep 标记与父级 diff 后的样式 s）；3. 交互元素逐条对照 interactions；4. 隐藏覆盖层结构在 overlays；5. 还原时覆盖全部断点与主题态。`);
  fs.writeFileSync(path.join(outDir, 'summary.md'), L.join('\n'));

  console.log(JSON.stringify({
    ok: true, outDir, pages: pages.length,
    screens: pages.reduce((n, p) => n + (p.screens ? p.screens.length : 0), 0),
    overlays: pages.reduce((n, p) => n + (p.overlays ? p.overlays.length : 0), 0),
    failedRequests: failedReqs.length, elapsedSec: result.elapsedSec,
  }, null, 2));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
