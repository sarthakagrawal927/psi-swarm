#!/usr/bin/env node
// deploy-cf-cache-rules.mjs — fleet-wide CF Cache Rules deployment.
//
// Each fleet zone gets a single Cache Rule named "Fleet: Cache HTML at
// edge" that matches `/` (exact) + `*.html` and tells the edge to cache
// the response for 1 day with a 1-week stale-while-revalidate window.
// Pages projects return `cf-cache-status: DYNAMIC` on HTML by default;
// this rule flips it to HIT.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... node scripts/deploy-cf-cache-rules.mjs
// or with a token argument:
//   node scripts/deploy-cf-cache-rules.mjs --token <TOKEN>
//
// The token must have:
//   - Zone:Read on all listed zones
//   - Zone Cache Rules:Edit on all listed zones
//
// Idempotent: running twice will detect the existing rule and skip;
// pass --update to overwrite.

const TOKEN = (() => {
  const argTok = process.argv.includes("--token")
    ? process.argv[process.argv.indexOf("--token") + 1]
    : null;
  return argTok || process.env.CLOUDFLARE_API_TOKEN;
})();

if (!TOKEN) {
  console.error("Missing CLOUDFLARE_API_TOKEN (env var) or --token flag");
  process.exit(1);
}

const UPDATE = process.argv.includes("--update");

const API_BASE = "https://api.cloudflare.com/client/v4";
const RULE_NAME = "Fleet: Cache HTML at edge";

// Fleet zones that should get the rule. Each zone is identified by its
// apex hostname; the script looks up the zone ID via the Zones API.
const ZONES = [
  "karte.cc",
  "rolepatch.com",
  "significanthobbies.com",
  "sassmaker.com",
  "codevetter.com",
  "aliveville.com",
  "sarthakagrawal.dev",
];

async function cf(path, init = {}) {
  const url = `${API_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    const msg = json?.errors?.[0]?.message || res.statusText;
    throw new Error(`CF API ${res.status} ${path}: ${msg}`);
  }
  return json.result;
}

async function findZoneId(name) {
  const result = await cf(`/zones?name=${encodeURIComponent(name)}`);
  if (!result?.length) throw new Error(`Zone not found in CF account: ${name}`);
  return result[0].id;
}

async function getCacheRulesEntrypoint(zoneId) {
  // The cache-rules ruleset for a zone lives at this phase. CF auto-creates
  // it on first edit, but we GET it first to find the ID if it exists.
  try {
    return await cf(
      `/zones/${zoneId}/rulesets/phases/http_request_cache_settings/entrypoint`,
    );
  } catch {
    return null;
  }
}

function buildRule() {
  return {
    description: RULE_NAME,
    expression:
      // Free-plan-compatible operators only — `matches` (regex) requires
      // Business or WAF Advanced. Cover the canonical landing path + any
      // .html asset; query-less GET filter is dropped because CF Free
      // doesn't expose a "no query" predicate without regex.
      `(http.request.uri.path eq "/") or ` +
      `(ends_with(http.request.uri.path, ".html"))`,
    action: "set_cache_settings",
    action_parameters: {
      cache: true,
      edge_ttl: {
        mode: "respect_origin", // let the Worker's Cache-Control header drive TTL
      },
      browser_ttl: {
        mode: "respect_origin",
      },
      // Don't set respect_strong_etags — it was breaking CF's
      // auto-recompression on cached responses (Vary mismatches).
    },
    enabled: true,
  };
}

async function applyZone(zoneName) {
  const zoneId = await findZoneId(zoneName);
  const rule = buildRule();

  const existing = await getCacheRulesEntrypoint(zoneId);
  if (existing?.id) {
    const fleetRule = existing.rules?.find((r) => r.description === RULE_NAME);
    if (fleetRule && !UPDATE) {
      console.log(`  ${zoneName}: rule already present (skip; pass --update to overwrite)`);
      return { zone: zoneName, status: "skipped-existing" };
    }
    // PATCH: replace or append the rule.
    const rules = (existing.rules || []).filter((r) => r.description !== RULE_NAME);
    rules.unshift(rule);
    await cf(`/zones/${zoneId}/rulesets/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify({
        rules,
        description: existing.description,
      }),
    });
    console.log(`  ${zoneName}: ${fleetRule ? "updated" : "added"} rule`);
    return { zone: zoneName, status: fleetRule ? "updated" : "added" };
  }

  // No entrypoint ruleset exists — POST a new one.
  await cf(
    `/zones/${zoneId}/rulesets`,
    {
      method: "POST",
      body: JSON.stringify({
        name: "default",
        kind: "zone",
        phase: "http_request_cache_settings",
        rules: [rule],
      }),
    },
  );
  console.log(`  ${zoneName}: created cache-rules ruleset with rule`);
  return { zone: zoneName, status: "created" };
}

async function main() {
  console.log(
    `\nApplying "${RULE_NAME}" to ${ZONES.length} zones${UPDATE ? " (--update)" : ""}\n`,
  );
  const results = [];
  for (const zone of ZONES) {
    try {
      results.push(await applyZone(zone));
    } catch (err) {
      console.error(`  ${zone}: FAILED — ${err.message}`);
      results.push({ zone, status: "error", error: err.message });
    }
  }
  console.log("\nSummary:");
  for (const r of results) console.log(`  ${r.status.padEnd(20)} ${r.zone}`);
  const failed = results.filter((r) => r.status === "error");
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
