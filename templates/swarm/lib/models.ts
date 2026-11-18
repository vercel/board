// The models a run can use, and what they cost, from AI Gateway's public list.

/** Dollars per token, as AI Gateway prices a model. */
export type Price = { input: number; output: number; cacheRead: number };

export type Model = { id: string; name: string; context: number; price: Price };

const LIST = "https://ai-gateway.vercel.sh/v1/models";

type Listed = {
  id: string;
  name?: string;
  type?: string;
  context_window?: number;
  tags?: string[];
  pricing?: { input?: string; output?: string; input_cache_read?: string };
};

let cached: { at: number; models: Model[] } | undefined;

/**
 * Every language model on AI Gateway that calls tools and has a price, by ID. Read again after ten
 * minutes. Empty when the list can't be read: the form then takes an ID typed by hand, and a
 * run without prices has no cost to hold to its budget.
 */
export async function models(request: typeof fetch = fetch): Promise<Model[]> {
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.models;
  const listed = await request(LIST, { signal: AbortSignal.timeout(10_000) })
    .then((response) => (response.ok ? (response.json() as Promise<{ data: Listed[] }>) : { data: [] }))
    .catch(() => ({ data: [] as Listed[] }));
  const found = listed.data
    .filter((model) => (model.type ?? "language") === "language" && model.tags?.includes("tool-use") && model.pricing?.input && !model.id.endsWith("-batch"))
    .map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      context: model.context_window ?? 128_000,
      price: {
        input: Number(model.pricing!.input),
        output: Number(model.pricing!.output ?? 0),
        cacheRead: Number(model.pricing!.input_cache_read ?? model.pricing!.input),
      },
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (found.length) cached = { at: Date.now(), models: found };
  return found;
}

const trim = (dollars: number) => (dollars >= 10 ? dollars.toFixed(0) : dollars.toFixed(2).replace(/\.?0+$/, ""));

/** A price as the form shows it: dollars per million tokens, in and out. */
export const perMillion = (price: Price) => `$${trim(price.input * 1e6)} in, $${trim(price.output * 1e6)} out per 1M`;
