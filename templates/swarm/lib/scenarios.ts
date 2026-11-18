import type { TaskInBatch } from "@vercel/board";
import { LABEL, taskText, type Planned, type Role } from "../sandbox/shared.ts";
import { taskCap, type Config } from "./config.ts";

// What each scenario puts in a run's queue. Tasks are the board's: one waits for another with
// `needs`, and the board makes it ready once that completes, so the order lives on the board and an
// agent only ever asks for the next ready task.
//
//   pipeline   plan ──▶ (the app adds) work 1 ──▶ review 1
//                                      work 2 ──▶ review 2 …
//   review     find src/ ──▶ verify src/ ─┐
//              find lib/ ──▶ verify lib/ ─┼──▶ report
//              …                          ┘

const role = (name: Role) => ({ [LABEL.role]: name });

/** One area of a repo to read: a name, and the paths it covers (a directory ends with `/`). */
export type Area = { name: string; paths: string[] };

const top = (path: string, depth: number) => {
  const parts = path.split("/");
  return parts.length > depth ? `${parts.slice(0, depth).join("/")}/` : path;
};

/**
 * The repo's files, split into at most `max` areas of about the same size: by top-level directory,
 * a directory much bigger than its share split by its subdirectories, and the smallest merged into
 * one at the end when there are too many. Files at the root go together.
 */
export function areas(files: string[], max: number): Area[] {
  const tracked = files.map((file) => file.trim()).filter((file) => file && !file.startsWith("."));
  if (tracked.length === 0 || max < 1) return [];
  type Group = { name: string; depth: number; paths: string[]; files: string[] };
  let groups: Group[] = [];
  const add = (name: string, depth: number, file: string, path: string) => {
    const group = groups.find((entry) => entry.name === name) ?? (groups.push({ name, depth, paths: [], files: [] }), groups[groups.length - 1]!);
    group.files.push(file);
    if (!group.paths.includes(path)) group.paths.push(path);
  };
  for (const file of tracked) file.includes("/") ? add(top(file, 1), 1, file, top(file, 1)) : add("(root)", 0, file, file);
  // A directory with more than half again its share is split by its subdirectories, when it has two or more.
  const share = (tracked.length / max) * 1.5;
  for (let rounds = 0; rounds < 20; rounds++) {
    const big = groups.filter((group) => group.depth > 0 && group.files.length > share && group.files.length >= 8).sort((a, b) => b.files.length - a.files.length)[0];
    if (!big) break;
    const depth = big.depth + 1;
    const dirs = new Set(big.files.map((file) => top(file, depth)).filter((key) => key.endsWith("/")));
    if (dirs.size < 2) {
      big.depth = Infinity; // can't be split usefully: leave it whole
      continue;
    }
    groups = groups.filter((group) => group !== big);
    for (const file of big.files) {
      const key = top(file, depth);
      // Files right in the directory stay together, under its own name.
      key.endsWith("/") ? add(key, depth, file, key) : add(big.name, Infinity, file, big.name);
    }
  }
  if (groups.length > max) {
    groups.sort((a, b) => b.files.length - a.files.length);
    const rest = groups.slice(max - 1);
    groups = [...groups.slice(0, max - 1), { name: "the rest", depth: 0, paths: rest.flatMap((group) => group.paths), files: rest.flatMap((group) => group.files) }];
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name)).map(({ name, paths }) => ({ name, paths: paths.slice(0, 60) }));
}

/** The tasks a run starts with, from its config and the repo's files. */
export function seed(config: Config, files: string[]): TaskInBatch[] {
  if (config.scenario === "pipeline") {
    return [
      {
        key: "plan",
        text: taskText(
          `Plan: ${config.title}`,
          `Split this goal into at most ${taskCap(config.agents)} tasks that agents can each finish alone, in one pull request:\n\n${config.goal}`,
        ),
        labels: role("plan"),
      },
    ];
  }
  const found = areas(files, taskCap(config.agents));
  const tasks: TaskInBatch[] = [];
  found.forEach((area, i) => {
    tasks.push({ key: `find-${i}`, text: `Review ${area.name}\n${area.paths.map((path) => `- ${path}`).join("\n")}`, labels: role("find") });
    tasks.push({ key: `verify-${i}`, text: taskText(`Verify the findings in ${area.name}`, "Check each finding of the review this waits for against the code."), labels: role("verify"), needs: [{ key: `find-${i}` }] });
  });
  tasks.push({
    key: "report",
    text: taskText(`Report: ${config.title}`, "Write the run's report from every verified finding."),
    labels: role("report"),
    needs: found.map((_, i) => ({ key: `verify-${i}` })),
  });
  return tasks;
}

/** A plan's tasks, as the queue holds them: each work task, and a review that waits for it. */
export function expand(plan: Planned[]): TaskInBatch[] {
  return plan.flatMap((task, i) => [
    { key: `work-${i}`, text: taskText(task.title, task.brief), labels: role("work") },
    { key: `review-${i}`, text: taskText(`Review: ${task.title}`, "Review the pull request of the task this waits for."), labels: role("review"), needs: [{ key: `work-${i}` }] },
  ]);
}
