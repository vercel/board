import assert from "node:assert/strict";
import { test } from "node:test";
import { policy } from "../agent/lib/policy.ts";
import { placeholders, serviceRules, threadServices, type Service } from "../agent/lib/services.ts";

// The keys besides GitHub's: which threads get them, what the sandbox's network policy is given,
// and what the sandbox itself sees of them. With services of the test's own, not this factory's.

const SERVICES: Record<string, Service> = {
  stripe: { env: "STRIPE_API_KEY", hosts: ["api.stripe.com", "files.stripe.com"], prefixes: ["rk_live_", "rk_test_"] },
  axiom: { env: "AXIOM_TOKEN", hosts: ["api.axiom.co"], prefixes: ["xaat-", "xapt-"], passthrough: ["AXIOM_ORG_ID"] },
  railway: { env: "RAILWAY_API_TOKEN", hosts: ["backboard.railway.com"] },
  acme: { env: "ACME_API_KEY", hosts: ["api.acme.dev"], headers: (key) => ({ "x-api-key": key }) },
};
const ENV = { STRIPE_API_KEY: "rk_live_secret", AXIOM_TOKEN: "xapt-secret", AXIOM_ORG_ID: "acme-x1", ACME_API_KEY: "acme-secret" };
const CHANNELS = { "project-factory/stripe": ["stripe"], "project-factory/web": ["axiom", "railway"] };

test("a thread gets the services of its own channel alone, and one anywhere else gets none", () => {
  assert.deepEqual(threadServices("project-factory/stripe", CHANNELS), ["stripe"]);
  assert.deepEqual(threadServices("project-factory/web", CHANNELS), ["axiom", "railway"]);
  assert.deepEqual(threadServices("project-factory/rsi", CHANNELS), []);
  // Not a channel under it, and not one it's under.
  assert.deepEqual(threadServices("project-factory/stripe/sub", CHANNELS), []);
  assert.deepEqual(threadServices("project-factory", CHANNELS), []);
  // A thread that couldn't be read.
  assert.deepEqual(threadServices(null, CHANNELS), []);
});

test("a service's key goes to its hosts on the way out, as a bearer token, and a key that isn't set adds nothing", () => {
  // Railway's key isn't in the env.
  const rules = serviceRules(["stripe", "railway"], ENV, SERVICES);
  assert.deepEqual(rules, {
    "api.stripe.com": [{ transform: [{ headers: { authorization: "Bearer rk_live_secret" } }] }],
    "files.stripe.com": [{ transform: [{ headers: { authorization: "Bearer rk_live_secret" } }] }],
  });
  // Only the services asked for: a thread without Stripe sends its key nowhere.
  assert.deepEqual(Object.keys(serviceRules(["axiom"], ENV, SERVICES)), ["api.axiom.co"]);
  assert.deepEqual(serviceRules([], ENV, SERVICES), {});
  // A name that's no service, as a typo in serviceChannels would be.
  assert.deepEqual(serviceRules(["strip"], ENV, SERVICES), {});
});

test("a service that takes its key in a header of its own gets that header, and no bearer token", () => {
  assert.deepEqual(serviceRules(["acme"], ENV, SERVICES), { "api.acme.dev": [{ transform: [{ headers: { "x-api-key": "acme-secret" } }] }] });
});

test("the sandbox sees a placeholder with the key's prefix, never the key", () => {
  const env = placeholders(ENV, SERVICES);
  assert.deepEqual(env, {
    STRIPE_API_KEY: "rk_live_from-the-network-policy",
    AXIOM_TOKEN: "xapt-from-the-network-policy",
    // No secret, so as it is.
    AXIOM_ORG_ID: "acme-x1",
    ACME_API_KEY: "from-the-network-policy",
  });
  for (const value of Object.values(env)) assert.doesNotMatch(value, /secret/);
  // A service's own env doesn't come along without its key.
  assert.deepEqual(placeholders({ AXIOM_ORG_ID: "acme-x1" }, SERVICES), {});
  // A key that starts some other way keeps nothing of itself.
  assert.deepEqual(placeholders({ STRIPE_API_KEY: "sk_live_secret" }, SERVICES), { STRIPE_API_KEY: "from-the-network-policy" });
});

test("a host goes to the first service that names it, and GitHub's hosts stay GitHub's", () => {
  const shared: Record<string, Service> = {
    first: { env: "FIRST_KEY", hosts: ["api.acme.dev"] },
    second: { env: "SECOND_KEY", hosts: ["api.acme.dev", "api.github.com"] },
  };
  const env = { FIRST_KEY: "first-secret", SECOND_KEY: "second-secret" };
  const { allow } = policy({ github: "gh-token", services: ["first", "second"] }, env, shared) as { allow: Record<string, unknown> };
  assert.deepEqual(allow["api.acme.dev"], [{ transform: [{ headers: { authorization: "Bearer first-secret" } }] }]);
  // A service can't swap its key in where the thread's GitHub token goes.
  assert.deepEqual(allow["api.github.com"], [{ transform: [{ headers: { authorization: "Bearer gh-token" } }] }]);
});

test("a factory with no services gives the sandbox nothing more", () => {
  assert.deepEqual(placeholders(ENV, {}), {});
  assert.deepEqual(serviceRules(["stripe"], ENV, {}), {});
});

test("a thread's requests get GitHub's token and its own services' keys on the way out, and no other key", () => {
  const github = { "api.github.com": [{ transform: [{ headers: { authorization: "Bearer gh-token" } }] }], "github.com": [{ transform: [{ headers: { authorization: `Basic ${btoa("x-access-token:gh-token")}` } }] }] };
  // A thread in Stripe's channel: both, and every other host as it is.
  assert.deepEqual(policy({ github: "gh-token", services: ["stripe"] }, ENV, SERVICES), {
    allow: {
      ...github,
      "api.stripe.com": [{ transform: [{ headers: { authorization: "Bearer rk_live_secret" } }] }],
      "files.stripe.com": [{ transform: [{ headers: { authorization: "Bearer rk_live_secret" } }] }],
      "*": [],
    },
  });
  // A thread anywhere else: the project has the keys, and none of them goes out.
  assert.deepEqual(policy({ github: "gh-token" }, ENV, SERVICES), { allow: { ...github, "*": [] } });
  // A thread with no repo and no service still reaches the network, with nothing added.
  assert.deepEqual(policy({ github: null }, ENV, SERVICES), { allow: { "*": [] } });
});
