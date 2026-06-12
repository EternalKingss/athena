import { randomUUID } from "node:crypto";

export type Skill = {
  id: string;
  name: string;
  verified: boolean;
  versions: SkillVersion[];
};

export type SkillVersion = {
  version: number;
  body: string;
  uses: number;
  successes: number;
  failures: number;
};

export class SkillRegistry {
  #skills = new Map<string, Skill>();

  saveUnverified(name: string, body: string): Skill {
    const skill = this.#skills.get(name) ?? { id: randomUUID(), name, verified: false, versions: [] };
    const best = skill.versions.at(-1);
    const successRate = best && best.uses > 0 ? best.successes / best.uses : 0;
    if (best && successRate > 0.7) {
      skill.versions.push({ version: best.version + 1, body, uses: 0, successes: 0, failures: 0 });
    } else if (best) {
      best.body = body;
    } else {
      skill.versions.push({ version: 1, body, uses: 0, successes: 0, failures: 0 });
    }
    this.#skills.set(name, skill);
    return skill;
  }

  load(name: string, actor: "interactive" | "background"): { allowed: boolean; reason: string } {
    const skill = this.#skills.get(name);
    if (!skill) return { allowed: false, reason: "missing" };
    if (skill.verified) return { allowed: true, reason: "verified" };
    if (actor === "background") return { allowed: false, reason: "background_unverified_denied" };
    return { allowed: false, reason: "tier2_unverified_skill_gate" };
  }

  promote(name: string): Skill {
    const skill = this.#skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    skill.verified = true;
    return skill;
  }
}

export function shouldCrystallize(toolCalls: string[]): boolean {
  return toolCalls.filter((tool) => tool !== "load_skill").length >= 4;
}
