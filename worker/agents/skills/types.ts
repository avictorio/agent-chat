// The shapes of the served skills: served/index.ts (written by npm run skills)
// holds them, the Worker's runtime (worker/agents/skills.ts) answers from
// them, and the build (build.ts) makes them. Types only.

/** A skill's SKILL.md frontmatter, as its file begins and every entry carries it. */
export type SkillFrontmatter = { name: string, description: string, metadata: { version: string } };

/** One file of a served skill: its URI, the name and title resources/list
 *  gives it (a SKILL.md's name and description are its skill's), its bytes as
 *  text, and their SHA-256 digest and length. */
export type ServedFile = { uri: string, name: string, title: string, description?: string, text: string, digest: string, size: number };

/** A served skill: its SKILL.md's URI, its frontmatter, and every file, its
 *  SKILL.md first, then the rest in path order. */
export type ServedSkill = { uri: string, frontmatter: SkillFrontmatter, files: ServedFile[] };
