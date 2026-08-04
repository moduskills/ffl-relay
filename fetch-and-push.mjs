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
  "penalties_order", "direct_freekicks_order", "corners_and_indirect_freekicks_order",
];

const US_FIELDS = ["player_name", "team_title", "games", "time", "goals", "assists", "xG", "xA", "npxG", "shots", "key_passes"];

// Understat: shot-model xG/xA. Seasons are named by starting year; fetch the
// current one plus last season (the meaningful sample in preseason/early GWs).
async function fetchUnderstat(season) {
  const res = await fetch("https://understat.com/main/getPlayersStats/", {
    method: "POST",
    headers: {
      ...UA,
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Referer: `https://understat.com/league/EPL/${season}`,
    },
    body: `league=EPL&season=${season}`,
  });
  if (!res.ok) throw new Error(`understat ${season} -> ${res.status}`);
  const j = await res.json();
  if (!j.success || !Array.isArray(j.players)) throw new Error(`understat ${season}: bad payload`);
  return {
    season,
    players: j.players
      .filter((p) => (parseInt(p.time) || 0) > 0)
      .map((p) => Object.fromEntries(US_FIELDS.map((f) => [f, p[f]]))),
  };
}

// ClubElo: team strength ratings, one CSV row per club.
async function fetchElo() {
  const date = new Date().toISOString().slice(0, 10);
  const res = await fetch(`http://api.clubelo.com/${date}`);
  if (!res.ok) throw new Error(`clubelo -> ${res.status}`);
  const rows = (await res.text()).trim().split("\n").slice(1).map((l) => l.split(","));
  return rows
    .filter((r) => r[2] === "ENG")
    .slice(0, 40)
    .map((r) => ({ club: r[1], elo: Math.round(parseFloat(r[4])) }));
}

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

// Secondary sources — each is best-effort; the monitor renormalises scoring
// weights over whatever arrives.
const sources = { understat: [], elo: null };
const seasonStartYear = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
for (const season of [seasonStartYear, seasonStartYear - 1]) {
  try {
    const s = await fetchUnderstat(season);
    if (s.players.length) sources.understat.push(s);
  } catch (err) {
    relayErrors.push(`understat: ${err.message}`);
  }
}
try {
  sources.elo = await fetchElo();
} catch (err) {
  relayErrors.push(`clubelo: ${err.message}`);
}

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
  body: JSON.stringify({ bootstrap, fixtures, entry, picks, sources, relayErrors }),
});
const out = await res.json().catch(() => ({}));
console.log(`ingest -> ${res.status}`, JSON.stringify(out));
if (!res.ok) process.exit(1);
