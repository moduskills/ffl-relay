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

// Authenticated FPL fetch: headless login via the account.premierleague.com
// OAuth flow, then /my-team/ with the SPA's bearer token. This is the only way
// to see the CURRENT squad (incl. preseason drafts and pre-deadline transfers);
// the public picks API only shows gameweeks already locked in.
async function fetchMyTeam(teamId) {
  if (!process.env.FPL_EMAIL || !process.env.FPL_PASS || !teamId) return null;
  const { chromium } = await import("playwright");
  const crypto = await import("node:crypto");

  // Own PKCE flow against the PL SSO (PingFederate) — independent of the FPL
  // SPA's hydration, which behaves differently on CI runners.
  const CLIENT_ID = "bfcbaf69-aade-4c1b-8f00-c1cb8a193030";
  const REDIRECT = "https://fantasy.premierleague.com/";
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authUrl =
    "https://account.premierleague.com/as/authorize" +
    `?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    "&response_type=code&scope=openid+profile+email+offline_access" +
    `&state=${crypto.randomBytes(12).toString("hex")}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&language=en`;

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: UA["User-Agent"] + " Chrome/126.0 Safari/537.36" });
    const page = await ctx.newPage();

    // capture the authorization code the moment the SSO redirects back
    let authCode = null;
    page.on("request", (req) => {
      const u = req.url();
      if (u.startsWith(REDIRECT) && u.includes("code=")) {
        authCode = new URL(u).searchParams.get("code");
      }
    });

    await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    const email = page.locator('input[type="email"], input[name="username"], input[id*="email" i]').first();
    await email.waitFor({ timeout: 25000 }).catch(async () => {
      const body = await page.evaluate(() => document.body?.innerText?.slice(0, 250)).catch(() => "?");
      throw new Error(`no login form at ${page.url()} :: ${body}`);
    });
    await email.fill(process.env.FPL_EMAIL);
    await page.locator('input[type="password"]').first().fill(process.env.FPL_PASS);
    const allow = page.locator('button:has-text("Allow All"), #onetrust-accept-btn-handler').first();
    if (await allow.isVisible().catch(() => false)) { await allow.click().catch(() => {}); await page.waitForTimeout(800); }
    await page.locator('button.button--filled:has-text("Sign In")').first().click();

    for (let i = 0; i < 60 && !authCode; i++) await page.waitForTimeout(500);
    if (!authCode) {
      const hint = await page.evaluate(() => document.body?.innerText?.slice(0, 200)).catch(() => "?");
      throw new Error(`no auth code after submit at ${page.url()} :: ${hint}`);
    }

    const tokenRes = await ctx.request.post("https://account.premierleague.com/as/token", {
      form: {
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      },
    });
    if (!tokenRes.ok()) throw new Error(`token exchange -> ${tokenRes.status()}`);
    const { access_token } = await tokenRes.json();
    if (!access_token) throw new Error("token exchange returned no access_token");

    const res = await ctx.request.get(`${BASE}/my-team/${teamId}/`, {
      headers: { "X-Api-Authorization": `Bearer ${access_token}` },
    });
    if (!res.ok()) throw new Error(`my-team -> ${res.status()}`);
    return await res.json();
  } finally {
    await browser.close();
  }
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
let myTeam = null;
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
  try {
    myTeam = await fetchMyTeam(teamId);
  } catch (err) {
    relayErrors.push(`my-team login: ${err.message}`);
  }
}

const res = await fetch(`${INGEST_BASE}/ingest?key=${KEY}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ bootstrap, fixtures, entry, picks, myTeam, sources, relayErrors }),
});
const out = await res.json().catch(() => ({}));
console.log(`ingest -> ${res.status}`, JSON.stringify(out));
if (!res.ok) process.exit(1);
