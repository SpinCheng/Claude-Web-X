// commands lib: frontmatter, namespacing, override merge, builtin integrity
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_COMMANDS, parseCommandFrontmatter, scanCommandsDir, collectCommands, scanSkillsDir, collectSkills } from '../../bridge/lib/commands.js';

test('builtins: P0/P1/P2 whitelist intact, names unique and lowercase', () => {
  const names = BUILTIN_COMMANDS.map((c) => c.name);
  assert.ok(names.includes('compact') && names.includes('clear') && names.includes('context') && names.includes('usage'), 'P0 present');
  assert.ok(!names.includes('add-dir'), 'add-dir removed (headless实测不可用)');
  assert.ok(names.includes('mcp') && names.includes('autocompact') && names.includes('output-style'), 'P1 present');
  assert.ok(names.includes('goal') && names.includes('list-agents'), 'v110 additions present');
  assert.ok(names.includes('init') && names.includes('security-review') && names.includes('recap') && names.includes('skill-doctor') && names.includes('reload-skills') && names.includes('reload-plugins'), 'P2 present');
  assert.equal(new Set(names).size, names.length, 'no duplicate names');
  for (const n of names) assert.equal(n, n.toLowerCase(), 'lowercase: ' + n);
  for (const c of BUILTIN_COMMANDS) assert.ok(c.desc, 'desc: ' + c.name);
});

test('frontmatter: description + argument-hint parsed; non-command keys ignored', () => {
  const fm = parseCommandFrontmatter('---\ndescription: Deploy to env\nargument-hint: <env>\nallowed-tools: Bash(*)\n---\n\nBody $ARGUMENTS');
  assert.equal(fm.description, 'Deploy to env');
  assert.equal(fm['argument-hint'], '<env>');
  assert.equal(fm['allowed-tools'], undefined);
  assert.deepEqual(parseCommandFrontmatter('no frontmatter here'), {});
  assert.deepEqual(parseCommandFrontmatter('---\ndescription: unterminated'), {});
});

test('scan: .md only, subdirs namespace with ":", hidden dirs skipped, bad files tolerated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdscan-'));
  fs.writeFileSync(path.join(root, 'deploy.md'), '---\ndescription: Deploy it\nargument-hint: <env>\n---\nbody');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not a command');
  fs.writeFileSync(path.join(root, 'broken.md'), '\x00'); // readFileSync still works; frontmatter absent
  fs.mkdirSync(path.join(root, 'fe'));
  fs.writeFileSync(path.join(root, 'fe', 'button.md'), '---\ndescription: Button comp\n---\nx');
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, '.hidden', 'nope.md'), 'x');
  const got = scanCommandsDir(root);
  const by = Object.fromEntries(got.map((c) => [c.name, c]));
  assert.equal(by.deploy.desc, 'Deploy it');
  assert.equal(by.deploy.argHint, '<env>');
  assert.equal(by['fe:button'].desc, 'Button comp');
  assert.ok(!by.notes && !by.nope, 'non-md and hidden skipped');
  assert.ok(by.broken && by.broken.desc === '', 'md without frontmatter is still a command (empty desc)');
  fs.rmSync(root, { recursive: true, force: true });
});

test('collect: builtins first, project overrides user, missing user dir tolerated', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdcol-'));
  fs.mkdirSync(path.join(cwd, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'commands', 'projonly.md'), '---\ndescription: project one\n---\nx');
  const got = collectCommands(cwd);
  assert.equal(got[0].src, '内置');
  assert.ok(got[0].name === 'context');
  const proj = got.filter((c) => c.src === '项目');
  assert.equal(proj.length, 1);
  assert.equal(proj[0].name, 'projonly');
  // no cwd at all -> builtins only, still labeled
  const bare = collectCommands(null);
  assert.equal(bare.length, BUILTIN_COMMANDS.length);
  assert.ok(bare.every((c) => c.src === '内置'));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('skills scan: <name>/SKILL.md only, hidden skipped, desc from frontmatter, sorted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillscan-'));
  fs.mkdirSync(path.join(root, 'archify'));
  fs.writeFileSync(path.join(root, 'archify', 'SKILL.md'), '---\nname: archify\ndescription: Build architecture diagrams\n---\nbody');
  fs.mkdirSync(path.join(root, 'dataviz'));
  fs.writeFileSync(path.join(root, 'dataviz', 'SKILL.md'), '---\ndescription: Charts\n---\nbody');
  fs.mkdirSync(path.join(root, 'loose'));          // no SKILL.md -> not a skill
  fs.writeFileSync(path.join(root, 'loose', 'x.md'), 'y');
  fs.writeFileSync(path.join(root, 'flat.md'), 'z'); // file at root -> not a skill
  fs.mkdirSync(path.join(root, '.hid'));
  fs.writeFileSync(path.join(root, '.hid', 'SKILL.md'), '---\ndescription: nope\n---\nx');
  const got = scanSkillsDir(root);
  assert.deepEqual(got.map((s) => s.name), ['archify', 'dataviz']);
  assert.equal(got[0].desc, 'Build architecture diagrams');
  assert.equal(got[1].desc, 'Charts');
  fs.rmSync(root, { recursive: true, force: true });
});

test('skills collect: project overrides user, missing user dir tolerated', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcol-'));
  fs.mkdirSync(path.join(cwd, '.claude', 'skills', 'projskill'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'skills', 'projskill', 'SKILL.md'), '---\ndescription: project skill\n---\nx');
  const got = collectSkills(cwd);
  const proj = got.filter((s) => s.src === '项目');
  assert.equal(proj.length, 1);
  assert.equal(proj[0].name, 'projskill');
  assert.equal(proj[0].desc, 'project skill');
  assert.equal(collectSkills(null).filter((s) => s.src === '项目').length, 0);
  fs.rmSync(cwd, { recursive: true, force: true });
});
