// skills.mjs -- skill scanning, loading, and self-building
// Versioned: every save/update backs up the previous SKILL.md to versions/vN.md
// Rollback: rollbackSkill(name, version) restores a prior version.
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.mjs';

// ---- Get skill verification status ----
export function getSkillStatus(name) {
  if (!name) return null;
  const mdPath = join(PATHS.skills, name, 'SKILL.md');
  if (!existsSync(mdPath)) return null;
  try {
    const content = readFileSync(mdPath, 'utf8');
    const m = content.match(/^status:\s*(\S+)/m);
    return m ? m[1].trim() : 'verified';
  } catch { return 'verified'; }
}

// ---- Scan available skills ----
export function scanSkills() {
  if (!existsSync(PATHS.skills)) return [];
  const skills = [];
  try {
    const dirs = readdirSync(PATHS.skills);
    for (const dir of dirs) {
      const mdPath = join(PATHS.skills, dir, 'SKILL.md');
      if (!existsSync(mdPath)) continue;
      const content = readFileSync(mdPath, 'utf8');
      const descMatch = content.match(/^description:\s*(.+)$/m);
      const firstContentLine = content.split('\n').find(l => l.trim() && !l.startsWith('---') && !l.startsWith('#') && !l.includes(':'))?.trim();
      const desc = descMatch ? descMatch[1].trim() : firstContentLine || dir;
      skills.push({ dir, desc });
    }
  } catch {}
  return skills;
}

// ---- Load a skill's full instructions ----
export function loadSkill(name) {
  const mdPath = join(PATHS.skills, name, 'SKILL.md');
  if (!existsSync(mdPath)) return 'Skill "' + name + '" not found.';
  return readFileSync(mdPath, 'utf8');
}

// ---- Internal: backup current SKILL.md to versions/ before overwriting ----
// Returns the new version number.
async function backupCurrentSkill(name) {
  const skillDir = join(PATHS.skills, name);
  const mdPath   = join(skillDir, 'SKILL.md');
  if (!existsSync(mdPath)) return 0;

  const versionsDir = join(skillDir, 'versions');
  mkdirSync(versionsDir, { recursive: true });

  // Read / update meta.json
  const metaPath = join(skillDir, 'meta.json');
  let meta = { currentVersion: 0, createdAt: null, lastUpdated: null, successCount: 0, failureCount: 0 };
  if (existsSync(metaPath)) {
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch {}
  }
  meta.currentVersion = (meta.currentVersion || 0) + 1;
  meta.lastUpdated    = new Date().toISOString();
  if (!meta.createdAt) meta.createdAt = meta.lastUpdated;

  // Copy SKILL.md to versions/vN.md
  await writeFile(
    join(versionsDir, 'v' + meta.currentVersion + '.md'),
    readFileSync(mdPath, 'utf8')
  );

  // Prune versions dir to max 10 files
  const vfiles = readdirSync(versionsDir)
    .filter(f => /^v\d+\.md$/.test(f))
    .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
  for (const f of vfiles.slice(0, Math.max(0, vfiles.length - 10))) {
    await unlink(join(versionsDir, f)).catch(() => {});
  }

  await writeFile(metaPath, JSON.stringify(meta, null, 2));
  return meta.currentVersion;
}

// ---- Save a new skill ----
export async function saveSkill(name, description, content, status) {
  if (status === undefined) status = 'verified';
  const skillDir = join(PATHS.skills, name);
  mkdirSync(skillDir, { recursive: true });
  await backupCurrentSkill(name);
  const mdPath = join(skillDir, 'SKILL.md');
  const header = [
    '---',
    'name: ' + name,
    'description: ' + description,
    'created: ' + new Date().toISOString().slice(0, 10),
    'status: ' + status,
    '---',
    '',
    '',
  ].join('\n');
  await writeFile(mdPath, header + content);
  return 'Skill "' + name + '" saved to skills/' + name + '/SKILL.md';
}

// ---- Update an existing skill ----
export async function updateSkill(name, description, content, status) {
  if (status === undefined) status = 'verified';
  const mdPath = join(PATHS.skills, name, 'SKILL.md');
  if (!existsSync(mdPath)) return 'Skill "' + name + '" not found -- use save_skill to create it.';
  await backupCurrentSkill(name);
  const header = [
    '---',
    'name: ' + name,
    'description: ' + description,
    'updated: ' + new Date().toISOString().slice(0, 10),
    'status: ' + status,
    '---',
    '',
    '',
  ].join('\n');
  await writeFile(mdPath, header + content);
  return 'Skill "' + name + '" updated.';
}

// ---- Roll back to a prior version ----
export async function rollbackSkill(name, version) {
  const versionPath = join(PATHS.skills, name, 'versions', 'v' + version + '.md');
  if (!existsSync(versionPath)) return 'Version v' + version + ' not found for skill "' + name + '".';
  const content = readFileSync(versionPath, 'utf8');
  await writeFile(join(PATHS.skills, name, 'SKILL.md'), content);
  return 'Rolled back "' + name + '" to v' + version + '.';
}

// ---- List available versions for a skill ----
export function listSkillVersions(name) {
  const versionsDir = join(PATHS.skills, name, 'versions');
  if (!existsSync(versionsDir)) return [];
  return readdirSync(versionsDir)
    .filter(f => /^v\d+\.md$/.test(f))
    .map(f => parseInt(f.slice(1)))
    .sort((a, b) => a - b);
}

// ---- Update skill stats (success/failure counters) ----
export function recordSkillResult(name, success) {
  const metaPath = join(PATHS.skills, name, 'meta.json');
  try {
    let meta = {};
    if (existsSync(metaPath)) {
      try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch {}
    }
    if (success) meta.successCount = (meta.successCount || 0) + 1;
    else         meta.failureCount = (meta.failureCount || 0) + 1;
    writeFile(metaPath, JSON.stringify(meta, null, 2)).catch(() => {});
  } catch {}
}
