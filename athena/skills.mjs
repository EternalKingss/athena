// skills.mjs - skill scanning, loading, and self-building
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.mjs';

// ---- Get skill verification status ----
// Returns 'verified', 'unverified', or null if skill does not exist.
// Skills with no status field (manually created) default to 'verified'.
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

// ---- Save a new skill (Athena self-builds) ----
// status: 'verified' for manual saves, 'unverified' for auto-crystallized skills
export async function saveSkill(name, description, content, status) {
  if (status === undefined) status = 'verified';
  const skillDir = join(PATHS.skills, name);
  mkdirSync(skillDir, { recursive: true });
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
