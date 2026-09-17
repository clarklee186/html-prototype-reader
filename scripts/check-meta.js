#!/usr/bin/env node
/**
 * 元数据一致性校验（npm test 调用）
 *  ① _meta.json.description 与 SKILL.md frontmatter description 逐字一致
 *  ② _meta.json.version 与 package.json version 一致
 *  ③ version 为 semver；SKILL.md frontmatter 仅 name + description 两个顶层字段
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const problems = [];

const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
const fmMatch = skill.match(/^---\n([\s\S]*?)\n---/);
if (!fmMatch) problems.push('SKILL.md 缺少 YAML frontmatter');
const fm = fmMatch ? fmMatch[1] : '';
const fields = fm.split('\n').filter(l => /^[a-zA-Z_-]+:/.test(l)).map(l => l.split(':')[0]);
const descMatch = fm.match(/description:\s*([\s\S]*?)(?=\n[a-zA-Z_-]+:|\s*$)/);
const fmDesc = descMatch ? descMatch[1].trim() : '';

const meta = JSON.parse(fs.readFileSync(path.join(ROOT, '_meta.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

if (meta.description !== fmDesc) problems.push('_meta.json.description 与 SKILL.md frontmatter description 不一致');
if (meta.version !== pkg.version) problems.push(`版本不一致：_meta.json=${meta.version} package.json=${pkg.version}`);
if (!/^\d+\.\d+\.\d+$/.test(meta.version)) problems.push('version 不是 semver：' + meta.version);
const extraFields = fields.filter(f => f !== 'name' && f !== 'description');
if (extraFields.length) problems.push('SKILL.md frontmatter 含多余字段：' + extraFields.join(', '));
if (!/^[a-z0-9-]+$/.test(meta.name)) problems.push('name 不是 kebab-case：' + meta.name);
if (fmDesc.length > 1024) problems.push('description 超过 1024 字符：' + fmDesc.length);

if (problems.length) {
  console.error('check-meta 失败：');
  problems.forEach(p => console.error('  - ' + p));
  process.exit(1);
}
console.log(`  check-meta：OK（version ${meta.version}，description ${fmDesc.length} 字符，frontmatter 仅 name+description）`);
