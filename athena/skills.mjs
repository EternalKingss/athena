// skills.mjs — skill scanning, loading, and self-building
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.mjs';

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
  if (!existsSync(mdPath)) return `Skill "${name}" not found.`;
  return readFileSync(mdPath, 'utf8');
}

// ---- Save a new skill (Athena self-builds) ----
export async function saveSkill(name, description, content) {
  const skillDir = join(PATHS.skills, name);
  mkdirSync(skillDir, { recursive: true });
  const mdPath = join(skillDir, 'SKILL.md');
  const header = `---\nname: ${name}\ndescription: ${description}\ncreated: ${new Date().toISOString().slice(0, 10)}\n---\n\n`;
  await writeFile(mdPath, header + content);
  return `Skill "${name}" saved to skills/${name}/SKILL.md`;
}

// ---- Update an existing skill ----
export async function updateSkill(name, description, content) {
  const mdPath = join(PATHS.skills, name, 'SKILL.md');
  if (!existsSync(mdPath)) return `Skill "${name}" not found — use save_skill to create it.`;
  const header = `---\nname: ${name}\ndescription: ${description}\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n`;
  await writeFile(mdPath, header + content);
  return `Skill "${name}" updated.`;
}
