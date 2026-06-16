import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const START_DATE = "2026-06-11";
const END_DATE = "2026-07-19";
const RESULTS_FILE = path.resolve("data/results.js");
const SCHEDULE_FILE = path.resolve("data/schedule.js");
const TEAMS_FILE = path.resolve("data/teams.js");

const STAGE_BY_SLUG = {
  "group-stage": "Groups",
  "round-of-32": "R32",
  "round-of-16": "R16",
  quarterfinals: "Quarter",
  semifinals: "Semi",
  final: "Final"
};

const SKIPPED_STAGE_SLUGS = new Set(["3rd-place-match", "third-place-match"]);

const TEAM_OVERRIDES = new Map([
  ["united states", "USA"],
  ["us", "USA"],
  ["turkiye", "Turkiye"],
  ["turkiye", "Turkiye"],
  ["turkey", "Turkiye"],
  ["bosnia and herzegovina", "Bosnia"],
  ["bosnia herzegovina", "Bosnia"],
  ["cote d ivoire", "Ivory Coast"],
  ["cote d ivoire", "Ivory Coast"],
  ["congo dr", "DR Congo"],
  ["dr congo", "DR Congo"],
  ["democratic republic of congo", "DR Congo"],
  ["curacao", "Curacao"],
  ["cape verde", "Cape Verde"],
  ["cabo verde", "Cape Verde"],
  ["korea republic", "South Korea"],
  ["south korea", "South Korea"],
  ["ir iran", "Iran"]
]);

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatDateKeyInTimeZone(date = new Date(), timeZone = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

function dateRange(startDate, endDate) {
  const dates = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  for (let day = start; day <= end; day = new Date(day.getTime() + 24 * 60 * 60 * 1000)) {
    dates.push(formatDateKey(day));
  }
  return dates;
}

async function loadTeamLookup() {
  const source = await fs.readFile(TEAMS_FILE, "utf8");
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: TEAMS_FILE });

  const lookup = new Map();
  for (const team of context.window.POOL_TEAMS || []) {
    [team.name, ...(team.aliases || [])].forEach((name) => {
      lookup.set(normalize(name), team.name);
    });
  }
  for (const [name, canonical] of TEAM_OVERRIDES.entries()) {
    lookup.set(name, canonical);
  }
  return lookup;
}

function canonicalTeamName(name, lookup) {
  return lookup.get(normalize(name)) || name;
}

function resultCode(score, opponentScore) {
  if (score > opponentScore) return "W";
  if (score < opponentScore) return "L";
  return "D";
}

function stageFromEvent(event) {
  const slug = event.season?.slug || "";
  if (SKIPPED_STAGE_SLUGS.has(slug)) return null;
  return STAGE_BY_SLUG[slug] || "Groups";
}

async function fetchScoreboard(dateKey) {
  const url = `${SCOREBOARD_URL}?dates=${dateKey}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "bomboclats-world-cup-pool-updater"
    }
  });

  if (!response.ok) {
    throw new Error(`ESPN request failed for ${dateKey}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function collectCompletedEvents() {
  const seen = new Set();
  const completed = [];

  for (const dateKey of dateRange(START_DATE, END_DATE)) {
    const scoreboard = await fetchScoreboard(dateKey);
    for (const event of scoreboard.events || []) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);

      if (!event.status?.type?.completed) continue;
      const stage = stageFromEvent(event);
      if (!stage) continue;

      const competitors = event.competitions?.[0]?.competitors || [];
      if (competitors.length !== 2) continue;

      const withScores = competitors.map((competitor) => ({
        team: competitor.team?.displayName,
        score: Number(competitor.score)
      }));

      if (withScores.some((competitor) => !competitor.team || Number.isNaN(competitor.score))) continue;

      completed.push({
        id: event.id,
        date: event.date,
        stage,
        competitors: withScores
      });
    }
  }

  return completed.sort((a, b) => new Date(a.date) - new Date(b.date));
}

async function collectDailyEvents(dateKey, lookup) {
  const scoreboard = await fetchScoreboard(dateKey);
  return (scoreboard.events || [])
    .map((event) => {
      const stage = stageFromEvent(event);
      if (!stage) return null;

      const competitors = event.competitions?.[0]?.competitors || [];
      if (competitors.length !== 2) return null;

      return {
        id: event.id,
        date: event.date,
        stage,
        status: {
          state: event.status?.type?.state || "pre",
          completed: event.status?.type?.completed === true,
          description: event.status?.type?.description || "",
          detail: event.status?.type?.detail || "",
          shortDetail: event.status?.type?.shortDetail || "",
          displayClock: event.status?.displayClock || ""
        },
        competitors: competitors.map((competitor) => ({
          team: canonicalTeamName(competitor.team?.displayName, lookup),
          abbreviation: competitor.team?.abbreviation || "",
          score: Number(competitor.score || 0),
          winner: competitor.winner === true,
          homeAway: competitor.homeAway || ""
        }))
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function buildResults(events, lookup) {
  const results = [];

  for (const event of events) {
    const [home, away] = event.competitors;
    for (const [team, opponent] of [[home, away], [away, home]]) {
      results.push({
        team: canonicalTeamName(team.team, lookup),
        stage: event.stage,
        result: resultCode(team.score, opponent.score),
        advanceBonus: false,
        opponent: canonicalTeamName(opponent.team, lookup),
        score: team.score,
        opponentScore: opponent.score,
        sourceEventId: event.id,
        playedAt: event.date
      });
    }
  }

  return results;
}

function formatEtTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(date);
}

function formatEtDateLabel(dateKey) {
  const year = dateKey.slice(0, 4);
  const month = dateKey.slice(4, 6);
  const day = dateKey.slice(6, 8);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(new Date(`${year}-${month}-${day}T12:00:00Z`));
}

function serializeResult(result) {
  const entries = [
    ["team", result.team],
    ["stage", result.stage],
    ["result", result.result],
    ["advanceBonus", result.advanceBonus],
    ["opponent", result.opponent],
    ["score", result.score],
    ["opponentScore", result.opponentScore],
    ["sourceEventId", result.sourceEventId],
    ["playedAt", result.playedAt]
  ];

  return `  { ${entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ")} }`;
}

function serializeScheduleGame(game) {
  const entries = [
    ["id", game.id],
    ["stage", game.stage],
    ["kickoff", game.date],
    ["status", game.status],
    ["competitors", game.competitors]
  ];

  return `  { ${entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ")} }`;
}

async function main() {
  const lookup = await loadTeamLookup();
  const events = await collectCompletedEvents();
  const results = buildResults(events, lookup);
  const todayKey = formatDateKeyInTimeZone();
  const todayGames = await collectDailyEvents(todayKey, lookup);
  const latestEvent = events.at(-1);
  const latestText = latestEvent
    ? `Latest match: ${latestEvent.competitors[0].team} ${latestEvent.competitors[0].score}-${latestEvent.competitors[1].score} ${latestEvent.competitors[1].team}.`
    : "No completed matches found.";

  const output = `window.POOL_RESULTS_META = {
  lastUpdated: ${JSON.stringify(`${formatEtTimestamp()} from ESPN. ${latestText}`)},
  source: "ESPN FIFA World Cup scoreboard"
};

window.POOL_RESULTS = [
  // Auto-generated by scripts/update-results.mjs. Manual edits may be overwritten.
${results.map(serializeResult).join(",\n")}
];
`;

  const scheduleOutput = `window.POOL_SCHEDULE_META = {
  dateKey: ${JSON.stringify(todayKey)},
  dateLabel: ${JSON.stringify(formatEtDateLabel(todayKey))},
  lastUpdated: ${JSON.stringify(`${formatEtTimestamp()} from ESPN.`)},
  source: "ESPN FIFA World Cup scoreboard"
};

window.POOL_SCHEDULE = [
  // Auto-generated by scripts/update-results.mjs. Manual edits may be overwritten.
${todayGames.map(serializeScheduleGame).join(",\n")}
];
`;

  await fs.writeFile(RESULTS_FILE, output, "utf8");
  await fs.writeFile(SCHEDULE_FILE, scheduleOutput, "utf8");
  console.log(`Wrote ${results.length} result entries from ${events.length} completed matches.`);
  console.log(`Wrote ${todayGames.length} games for ${todayKey}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
