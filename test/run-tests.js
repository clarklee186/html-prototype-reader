#!/usr/bin/env node
/**
 * html-prototype-reader · 测试总入口（npm test）
 *
 * 三段（无外部测试框架依赖）：
 *   ① 组件覆盖矩阵：capture 对组件夹具的 24 项状态断言
 *   ② 验收链路：自比对（期望零差异）+ 变异副本（期望被检出）
 *   ③ 仓库一致性：元数据（check-meta）+ 文档（check-docs）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const FIXTURES = path.join(__dirname, 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hpr-test-'));

let failures = 0, checks = 0;
const ok = (label, extra = '') => { checks++; console.log('  ✅ ' + label + (extra ? '  ' + extra : '')); };
const bad = (label, extra = '') => { checks++; failures++; console.log('  ❌ ' + label + (extra ? '  ' + extra : '')); };

function runNode(script, args = [], opts = {}) {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function runCapture(input, out, extra = []) { runNode(path.join(SCRIPTS, 'capture.js'), [input, out, ...extra]); }
function runDiff(a, b, out, extra = []) { try { return runNode(path.join(SCRIPTS, 'diff.js'), [a, b, out, ...extra]); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } }

/* ---------------- ① 组件覆盖矩阵 ---------------- */
function componentMatrix() {
  console.log('\n① 组件覆盖矩阵');
  const out = path.join(TMP, 'components');
  runCapture(path.join(FIXTURES, 'components.html'), out);
  const d = JSON.parse(fs.readFileSync(path.join(out, 'prototype.json'), 'utf8'));
  const p = d.pages[0];
  const sem = {};
  // offViewport 是节点级字段（不在 sem 里），断言时并入
  const walk = n => { if (!n) return; if (n.id) { if (n.sem) sem[n.id] = Object.assign({}, sem[n.id], n.sem); if (n.offViewport) sem[n.id] = Object.assign({}, sem[n.id], { offViewport: true }); } (n.ch || []).forEach(walk); };
  p.screens.forEach(s => walk(s.tree));
  const inter = p.screens.flatMap(s => s.interactions || []);
  const overlays = p.overlays || [];

  const assert = (label, fn) => { let v = false; try { v = !!fn(); } catch (e) { v = false; } v ? ok(label) : bad(label); };

  assert('checkbox 属性式 checked', () => sem['cb-attr'] && sem['cb-attr'].checked === true);
  assert('checkbox JS 式 checked', () => sem['cb-js'] && sem['cb-js'].checked === true);
  assert('checkbox indeterminate', () => sem['cb-js'] && sem['cb-js'].indeterminate === true);
  assert('radio 选中 / 未选中', () => sem['r2'] && sem['r2'].checked === true && sem['r1'] && sem['r1'].checked === false);
  assert('select 单选 options + selected', () => { const o = sem['sel-single'] && sem['sel-single'].options || []; return o.length === 3 && o.some(x => x.sel && x.t.includes('C')); });
  assert('select 多选 multiple + JS 选中 2 项', () => sem['sel-multi'] && sem['sel-multi'].multiple === true && (sem['sel-multi'].options || []).filter(o => o.sel).length === 2);
  assert('搜索框 JS 设置的 value', () => sem['q'] && sem['q'].value === 'AI 搜索词');
  assert('datalist 关联', () => sem['withdl'] && sem['withdl'].list === 'dl');
  assert('textarea JS 设置的 value', () => sem['ta'] && String(sem['ta'].value || '').includes('多行备注内容'));
  assert('range / number 值', () => String(sem['rg'] && sem['rg'].value) === '77' && String(sem['num'] && sem['num'].value) === '42');
  assert('details JS 打开 open', () => sem['acc'] && sem['acc'].open === true);
  assert('progress value/max', () => sem['pg'] && String(sem['pg'].value) === '70' && String(sem['pg'].max) === '100');
  assert('自定义 switch aria-checked', () => sem['sw'] && sem['sw']['aria-checked'] === 'true');
  assert('按钮 aria-pressed', () => sem['tgl'] && sem['tgl']['aria-pressed'] === 'true');
  assert('自定义 slider aria-valuenow', () => sem['sl'] && sem['sl']['aria-valuenow'] === '42');
  assert('contenteditable 文本', () => sem['ce'] && String(sem['ce'].editableText || '').includes('富文本编辑器内容'));
  assert('dialog 打开 open', () => sem['dlg-open'] && sem['dlg-open'].open === true);
  assert('dialog 关闭进 overlays(hiddenNow)', () => overlays.some(o => String(o.id || '').includes('dlg-closed') && o.hiddenNow === true));
  assert('离屏抽屉 offViewport', () => sem['drawer'] && sem['drawer'].offViewport === true);
  assert('抽屉内交互元素被收录', () => inter.some(i => (i.cls || []).includes('drawer-btn')));
  assert('label[for] 关联', () => JSON.stringify(p).includes('"for":"cb-attr"'));
  assert('schemaVersion 存在', () => d.schemaVersion === 1);
  assert('warnings 通道存在', () => Array.isArray(d.warnings) && Array.isArray(p.warnings));
  assert('externalHosts 字段存在', () => Array.isArray(p.externalHosts));
}

/* ---------------- ② 验收链路 ---------------- */
function acceptanceChain() {
  console.log('\n② 验收链路（capture + diff）');
  const proto = path.join(FIXTURES, 'components.html');
  // 变异副本：改主色与圆角
  const src = fs.readFileSync(proto, 'utf8');
  const mutant = path.join(TMP, 'mutant.html');
  fs.writeFileSync(mutant, src.replace('background: #fafafa', 'background: #eef1f6').replace('.drawer {', '.drawer { border-radius: 9px;'));

  const selfOut = path.join(TMP, 'self');
  runDiff(proto, proto, selfOut);
  const self = JSON.parse(fs.readFileSync(path.join(selfOut, 'diff.json'), 'utf8'));
  (self.pixel.ratio === 0) ? ok('自比对像素差异率为 0', `(${self.pixel.ratio})`) : bad('自比对像素差异率为 0', `(${self.pixel.ratio})`);
  (self.structureOk === true) ? ok('自比对结构维度产出正常') : bad('自比对结构维度产出正常');
  (self.structure.styleMismatchTotal === 0) ? ok('自比对样式无差异') : bad('自比对样式无差异', String(self.structure.styleMismatchTotal));

  const mutOut = path.join(TMP, 'mutant');
  runDiff(proto, mutant, mutOut);
  const mut = JSON.parse(fs.readFileSync(path.join(mutOut, 'diff.json'), 'utf8'));
  (mut.structure && mut.structure.styleMismatchTotal > 0) ? ok('变异副本被检出样式差异', `(${mut.structure.styleMismatchTotal} 项)`) : bad('变异副本被检出样式差异');

  // 失败路径：还原文件不存在 → 结构化失败 + 退出码 2（不得静默判"通过"）
  const failOut = path.join(TMP, 'fail');
  let code = 0;
  try { execFileSync(process.execPath, [path.join(SCRIPTS, 'diff.js'), proto, path.join(TMP, 'nope.html'), failOut], { stdio: 'ignore' }); }
  catch (e) { code = e.status; }
  (code === 2) ? ok('失败路径退出码为 2（未测到 ≠ 通过）') : bad('失败路径退出码为 2', '实际 ' + code);
  const fail = JSON.parse(fs.readFileSync(path.join(failOut, 'diff.json'), 'utf8'));
  (fail.structureOk === false && fail.structure === null && fail.pixel === null) ? ok('失败路径结构/像素置 null 而非 0') : bad('失败路径结构/像素置 null 而非 0');

  // 高页面分带：超过 max-height 必须告警并标注截断
  const tall = path.join(TMP, 'tall.html');
  const rows = Array.from({ length: 200 }, (_, i) => `<section class="row" id="r${i}"><h3>区块 ${i + 1}</h3><p>内容行 ${i + 1}</p></section>`).join('');
  fs.writeFileSync(tall, `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:14px sans-serif}.row{padding:20px;height:70px;border-bottom:1px solid #ddd}</style></head><body>${rows}</body></html>`);
  const tallOut = path.join(TMP, 'tall');
  runDiff(tall, tall, tallOut, ['--max-height', '4000', '--viewport', '800x600']);
  const tallRes = JSON.parse(fs.readFileSync(path.join(tallOut, 'diff.json'), 'utf8'));
  (tallRes.pixel.truncated === true && tallRes.pixel.height === 4000) ? ok('超高页面按 max-height 截断并标注') : bad('超高页面按 max-height 截断并标注', JSON.stringify({ t: tallRes.pixel.truncated, h: tallRes.pixel.height }));
  (tallRes.warnings.some(w => w.stage === 'pixel:truncated')) ? ok('截断产生显式告警') : bad('截断产生显式告警');
}

/* ---------------- ③ 仓库一致性 ---------------- */
function repoConsistency() {
  console.log('\n③ 仓库一致性');
  for (const s of ['check-meta.js', 'check-docs.js']) {
    try {
      const out = runNode(path.join(SCRIPTS, s), []);
      process.stdout.write(out);
      ok(s + ' 通过');
    } catch (e) {
      process.stdout.write((e.stdout || '') + (e.stderr || ''));
      bad(s + ' 通过');
    }
  }
}

console.log('html-prototype-reader · 测试（临时目录 ' + TMP + '）');
try {
  componentMatrix();
  acceptanceChain();
  repoConsistency();
} catch (e) {
  bad('测试执行异常', String(e).slice(0, 200));
}
console.log(`\n结果：${checks - failures}/${checks} 通过${failures ? '  ← 有失败项' : ''}`);
process.exitCode = failures ? 1 : 0;
