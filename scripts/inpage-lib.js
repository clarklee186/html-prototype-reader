'use strict';
/**
 * 页内库（注入浏览器执行）
 * 通过 Function.prototype.toString 序列化后注入页面，占位符由宿主替换：
 *   %STYLE_PROPS_JSON%  %ALWAYS_KEEP_JSON%  %IFRAME_DEPTH%
 * 单独成文件的原因：宿主可对其执行 node --check 与静态检查（内联在 capture.js 时无法校验）。
 */
/* ---------- 页内工具（注入浏览器执行） ---------- */
function inPageLib() {
  const STYLE_PROPS = JSON.parse('%STYLE_PROPS_JSON%');
  const ALWAYS_KEEP = new Set(JSON.parse('%ALWAYS_KEEP_JSON%'));
  const IFRAME_DEPTH_LIMIT = parseInt('%IFRAME_DEPTH%', 10);
  const TUNING = JSON.parse('%TUNING_JSON%');
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'META', 'HEAD', 'BR']);

  const rounded = r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  const isVisible = (el, cs) => {
    const st = cs || getComputedStyle(el); const r = el.getBoundingClientRect();
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
  const styleDiff = (el, parentMap, cs) => {
    const st = cs || getComputedStyle(el); const diff = {};
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
  const styleMap = (el, cs) => { const st = cs || getComputedStyle(el); const m = {}; for (const p of STYLE_PROPS) m[p] = st[p]; return m; };

  const textOf = el => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    t = t.replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, TUNING.wsMaxChars) : undefined;
  };

  function buildTree(el, parentMap, depth) {
    if (SKIP.has(el.tagName)) return null;
    const cs = getComputedStyle(el);   // 每元素只解析一次，供可见性/样式映射/样式 diff 复用
    const vis = isVisible(el, cs);
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
    const map = styleMap(el, cs);
    const sd = styleDiff(el, parentMap, cs); if (sd) node.s = sd;
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
    if (depth < TUNING.treeDepthLimit && el.children.length) {
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

module.exports = { inPageLib };
