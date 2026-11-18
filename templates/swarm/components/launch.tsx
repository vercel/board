"use client";

import type { ReactNode } from "react";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { start } from "@/app/actions";
import { ABOUT_SCENARIO, DEFAULTS, MAX_AGENTS, MAX_MINUTES, SCENARIOS, type Scenario } from "@/lib/config";
import { perMillion, type Model } from "@/lib/models";

/** Models by provider, the part of the ID before its `/`, in the order they're listed. */
function providers(models: Model[]): [string, Model[]][] {
  const by = new Map<string, Model[]>();
  for (const entry of models) {
    const provider = entry.id.split("/")[0]!;
    by.set(provider, [...(by.get(provider) ?? []), entry]);
  }
  return [...by];
}

/** The form that launches a run: a repo the GitHub app is on, a goal, a scenario, a model, how many agents, and when to stop. */
export function Launch({ repos, models, install }: { repos: string[]; models: Model[]; install: string | null }): ReactNode {
  const router = useRouter();
  const [pending, begin] = useTransition();
  const [scenario, setScenario] = useState<Scenario>(DEFAULTS.scenario);
  const [model, setModel] = useState(models.some((entry) => entry.id === DEFAULTS.model) ? DEFAULTS.model : (models[0]?.id ?? DEFAULTS.model));
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const price = useMemo(() => models.find((entry) => entry.id === model)?.price ?? null, [models, model]);

  return (
    <form
      className="launch"
      onSubmit={(event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.currentTarget));
        begin(async () => {
          const result = await start({ ...data, scenario, model });
          if (result.ok) {
            setSaid({ ok: true, text: `Launched ${result.slug}. It clones the repo and starts its first agent in a minute or two.` });
            router.refresh();
          } else setSaid({ ok: false, text: result.problem });
        });
      }}
    >
      <label className="row">
        <span>Repo</span>
        <select name="repo" required defaultValue={repos[0] ?? ""}>
          {repos.map((repo) => (
            <option key={repo} value={repo}>
              {repo}
            </option>
          ))}
        </select>
      </label>
      {install ? (
        <p className="note row-note">
          Missing one? <a href={install}>Add it to the GitHub app</a>.
        </p>
      ) : null}

      <fieldset className="row">
        <legend>Scenario</legend>
        <div className="choices">
          {SCENARIOS.map((id) => (
            <label key={id} className="choice" data-on={scenario === id ? "" : undefined}>
              <input type="radio" name="scenario-pick" value={id} checked={scenario === id} onChange={() => setScenario(id)} />
              <strong>{ABOUT_SCENARIO[id].label}</strong>
              <span>{ABOUT_SCENARIO[id].about}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="row">
        <span>Goal</span>
        <textarea
          name="goal"
          required
          minLength={15}
          rows={4}
          placeholder={scenario === "pipeline" ? "Add input validation to every API route, with a test for each." : "Find security bugs: injection, missing auth checks, secrets in logs."}
        />
      </label>

      <label className="row">
        <span>Model</span>
        {models.length ? (
          // Every model AI Gateway lists, by provider. A datalist would show only the ones matching what's filled in.
          <select name="model-pick" value={model} onChange={(event) => setModel(event.target.value)} required>
            {providers(models).map(([provider, entries]) => (
              <optgroup key={provider} label={provider}>
                {entries.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id.slice(provider.length + 1)} · {perMillion(entry.price)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : (
          <input name="model-pick" value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} autoComplete="off" required />
        )}
      </label>
      <p className="note row-note">{price ? perMillion(price) : models.length ? "No price listed for this model: give the run a time limit." : "Any AI Gateway model ID."}</p>

      <div className="numbers">
        <label>
          <span>Agents</span>
          <input name="agents" type="number" min={1} max={MAX_AGENTS} defaultValue={DEFAULTS.agents} required />
        </label>
        <label>
          <span>Budget, $</span>
          <input name="budgetUsd" type="number" min={1} max={10_000} defaultValue={DEFAULTS.budgetUsd ?? ""} placeholder="none" />
        </label>
        <label>
          <span>Minutes</span>
          <input name="minutes" type="number" min={5} max={MAX_MINUTES} defaultValue={DEFAULTS.minutes ?? ""} placeholder={`${MAX_MINUTES} at most`} />
        </label>
      </div>
      <p className="note row-note">A run stops at whichever comes first, or once its queue is done. Agents write under 16 shared names, agent-1 to agent-16. Past about 150 agents, the board's limit of 300 writes a minute from this project slows them down.</p>

      <div className="submit">
        <button type="submit" className="button" disabled={pending || repos.length === 0}>
          {pending ? "Launching" : "Launch"}
        </button>
        {said ? (
          <p className={said.ok ? "said" : "said bad"} role="status">
            {said.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}
