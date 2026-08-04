#!/usr/bin/env node
// FPL relay: runs on a network the FPL API allows (GitHub Actions, home machine),
// fetches the data the monitor needs, and POSTs it to the ingest function.
// The functions themselves cannot fetch FPL — Fastly 403s Google Cloud IPs.
//
// Usage: INGEST_BASE=https://europe-west2-ffl-monitor-rf.cloudfunctions.net \
//        SETUP_KEY=... node fetch-and-push.mjs

const BASE = "https://fantasy.premierleague.com/api";
const INGEST_BASE = process.env.INGEST_BASE ?? "https://europe-west2-ffl-monitor-rf.cloudfunctions.net";
const KEY = process.env.SETUP_KEY;
if (!KEY) {
  console.error("SETUP_KEY env var is required");
  process.exit(1);
}

const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" };

async function fpl(path) {
  const res = await fetch(`${BASE}${path}`, { headers: UA });
  if (!res.ok) throw new Error(`FPL ${path} -> ${res.status}`);
  return res.json();
}

// Slim the bootstrap to the fields the monitor uses — keeps the POST small.
const PLAYER_FIELDS = [
  "id", "web_name", "first_name", "second_name", "team", "element_type", "now_cost",
  "cost_change_event", "status", "news", "news_added", "chance_of_playing_next_round",
  "form", "points_per_game", "total_points", "event_points", "selected_by_percent",
  "minutes", "ict_index", "expected_goals", "expected_assists",
  "expected_goal_involvements", "expected_goals_conceded", "ep_next",
  "transfers_in_event", "transfers_out_event",
];

const relayErrors = [];

const cfgRes = await fetch(`${INGEST_BASE}/relayConfig?key=${KEY}`);
if (!cfgRes.ok) throw new Error(`relayConfig -> ${cfgRes.status}`);
const { teamId } = await cfgRes.json();

const [bootstrapFull, fixtures] = await Promise.all([fpl("/bootstrap-static/"), fpl("/fixtures/")]);
const bootstrap = {
  elements: bootstrapFull.elements.map((p) => Object.fromEntries(PLAYER_FIELDS.map((f) => [f, p[f]]))),
  teams: bootstrapFull.teams.map(({ id, name, short_name, strength }) => ({ id, name, short_name, strength })),
  events: bootstrapFull.events.map(({ id, name, deadline_time, finished, is_current, is_next, average_entry_score }) =>
    ({ id, name, deadline_time, finished, is_current, is_next, average_entry_score })),
};

let entry = null;
let picks = null;
if (teamId) {
  try {
    entry = await fpl(`/entry/${teamId}/`);
    const event = entry.current_event ?? bootstrap.events.find((e) => e.is_current)?.id ?? null;
    if (event) {
      try {
        picks = await fpl(`/entry/${teamId}/event/${event}/picks/`);
      } catch (err) {
        relayErrors.push(`picks: ${err.message}`);
      }
    }
  } catch (err) {
    relayErrors.push(`entry ${teamId}: ${err.message}`);
  }
}

const res = await fetch(`${INGEST_BASE}/ingest?key=${KEY}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ bootstrap, fixtures, entry, picks, relayErrors }),
});
const out = await res.json().catch(() => ({}));
console.log(`ingest -> ${res.status}`, JSON.stringify(out));
if (!res.ok) process.exit(1);
