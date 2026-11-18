"use client";

import type { ReactNode } from "react";
import { useState, useTransition } from "react";

type Answer = { started: true; repo: string } | { started: false; repo: string; where: string } | { started: false; repo: string; missing: true } | { error: { message: string } };

/**
 * A repo to onboard, typed or pasted, and the button that asks the factory for it: a POST to the
 * page's own route. What it says after is what came back. `where` is where the factory was asked,
 * as people know it, and `suggest` the repos the field offers while someone types: the browser's
 * own list, so it works as every other field of theirs does.
 */
export function Onboard({ path, where, suggest }: { path: string; where: string; suggest: string[] }): ReactNode {
  const [repo, setRepo] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="onboard"
      onSubmit={(event) => {
        event.preventDefault();
        start(async () => {
          const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo }) }).catch(() => null);
          if (response?.status === 400) return setSaid("Write it as GitHub does: owner/repo.");
          const answer = response ? ((await response.json().catch(() => null)) as Answer | null) : null;
          // Nothing answered, or nothing that reads: trying again may help. A refusal says why, and trying again won't.
          if (!answer) return setSaid("Couldn't ask the factory. Try again.");
          if ("error" in answer) return setSaid(`Couldn't ask the factory: ${answer.error.message}.`);
          if (!answer.started && "missing" in answer) return setSaid(`The GitHub app isn't on ${answer.repo}. Add it on GitHub first.`);
          if (!answer.started) return setSaid(`${answer.repo} is already in ${answer.where}.`);
          setRepo("");
          setSaid(`Asked in ${where}. The factory opens a pull request for ${answer.repo}.`);
        });
      }}
    >
      <div className="field">
        <input
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
          placeholder="owner/repo"
          list={suggest.length ? "onboard-repos" : undefined}
          // A browser that's told not to complete a field may not offer its list either.
          autoComplete={suggest.length ? undefined : "off"}
          aria-label="A repo to onboard"
          autoCapitalize="none"
          spellCheck={false}
        />
        <button type="submit" className="button secondary" disabled={pending || !repo.trim()}>
          {pending ? "Asking" : "Onboard"}
        </button>
      </div>
      {suggest.length ? (
        <datalist id="onboard-repos">
          {suggest.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      ) : null}
      {said ? (
        <p className="note" role="status">
          {said}
        </p>
      ) : null}
    </form>
  );
}
