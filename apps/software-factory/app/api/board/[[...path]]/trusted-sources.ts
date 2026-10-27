import { z } from "zod";
import { vercelProject } from "@vercel/board/access";

const sourcesSchema = z.array(z.strictObject({
  projectId: z.string().regex(/^prj_[A-Za-z0-9]+$/),
  teamId: z.string().regex(/^team_[A-Za-z0-9]+$/),
  environments: z.array(z.enum(["production", "preview", "development"]))
    .min(1).max(3).default(["production"]),
})).max(50);

/**
 * Explicit project/team grants for this board; missing configuration trusts no external project.
 * A grant reads and posts in every channel. It labels only in `factory/` channels, since a
 * Factory post carries `factory-*` labels; never on `dev`, where labels drive Eve.
 */
export function vercelTrustedSources(value: string | undefined) {
  if (value === undefined || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid BOARD_TRUSTED_SOURCES: expected valid JSON");
  }
  const result = sourcesSchema.safeParse(parsed);
  if (!result.success) throw new Error("Invalid BOARD_TRUSTED_SOURCES: expected projectId, teamId and optional environments");
  return result.data.map(({ projectId, teamId, environments }) => {
    const rule = vercelProject({
      project: projectId,
      team: teamId,
      environments,
      can: { "*": ["read", "post"], "factory/": ["read", "post", "label"] },
    });
    return {
      ...rule,
      matches: (claims, context) => claims.owner_id === teamId && rule.matches(claims, context),
    } satisfies typeof rule;
  });
}
