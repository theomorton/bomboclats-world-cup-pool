(function () {
  const teams = window.POOL_TEAMS || [];
  const players = window.POOL_PLAYERS || [];
  const results = window.POOL_RESULTS || [];
  const resultsMeta = window.POOL_RESULTS_META || {};
  const initialSchedule = window.POOL_SCHEDULE || [];
  const initialScheduleMeta = window.POOL_SCHEDULE_META || {};

  const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
  const BUDGET = 150;
  const LIVE_REFRESH_MS = 60 * 1000;
  const RESULT_POINTS = { W: 3, D: 1, L: 0 };
  const STAGE_MULTIPLIERS = {
    Groups: 1,
    R32: 2,
    R16: 3,
    Quarter: 5,
    Semi: 8,
    Final: 12
  };
  const STAGE_BY_SLUG = {
    "group-stage": "Groups",
    "round-of-32": "R32",
    "round-of-16": "R16",
    quarterfinals: "Quarter",
    semifinals: "Semi",
    final: "Final"
  };
  const SKIPPED_STAGE_SLUGS = new Set(["3rd-place-match", "third-place-match"]);
  const GROUP_ORDER = [..."ABCDEFGHIJKL", "N/A", "TBD"];

  const COUNTRY_COLORS = {
    France: ["#2454d6", "#e45b5b"],
    Germany: ["#111827", "#f4b740"],
    Canada: ["#e31b23", "#ffffff"],
    Scotland: ["#005eb8", "#ffffff"],
    Greece: ["#0d5eaf", "#ffffff"],
    China: ["#de2910", "#ffde00"],
    USA: ["#2454d6", "#e45b5b"],
    "South Korea": ["#cd2e3a", "#0047a0"],
    Italy: ["#16833f", "#ce2b37"],
    England: ["#ffffff", "#c8102e"],
    Denmark: ["#c60c30", "#ffffff"],
    Bosnia: ["#002f6c", "#f7d117"],
    Netherlands: ["#ff4f00", "#21468b"],
    Ireland: ["#169b62", "#ff883e"]
  };

  const FLAG_CODES = {
    Algeria: "dz",
    Argentina: "ar",
    Australia: "au",
    Austria: "at",
    Belgium: "be",
    Bosnia: "ba",
    Brazil: "br",
    Canada: "ca",
    "Cape Verde": "cv",
    China: "cn",
    Colombia: "co",
    Croatia: "hr",
    Curacao: "cw",
    Czechia: "cz",
    Denmark: "dk",
    "DR Congo": "cd",
    Ecuador: "ec",
    Egypt: "eg",
    England: "gb-eng",
    France: "fr",
    Germany: "de",
    Ghana: "gh",
    Greece: "gr",
    Haiti: "ht",
    Iran: "ir",
    Iraq: "iq",
    Ireland: "ie",
    Italy: "it",
    "Ivory Coast": "ci",
    Japan: "jp",
    Jordan: "jo",
    Mexico: "mx",
    Morocco: "ma",
    Netherlands: "nl",
    "New Zealand": "nz",
    Norway: "no",
    Panama: "pa",
    Paraguay: "py",
    Portugal: "pt",
    Qatar: "qa",
    "Saudi Arabia": "sa",
    Scotland: "gb-sct",
    Senegal: "sn",
    "South Africa": "za",
    "South Korea": "kr",
    Spain: "es",
    Sweden: "se",
    Switzerland: "ch",
    Tunisia: "tn",
    Turkiye: "tr",
    Uruguay: "uy",
    USA: "us",
    Uzbekistan: "uz"
  };

  const normalize = (value) =>
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  const teamLookup = new Map();
  teams.forEach((team) => {
    [team.name, ...(team.aliases || [])].forEach((name) => {
      teamLookup.set(normalize(name), team);
    });
  });

  const state = {
    teamFilter: "all",
    search: "",
    focusedPlayerSlug: "",
    focusedTeamName: "",
    leaderboardMode: "official",
    playerSort: "points",
    playerFilter: "all",
    teamView: "group",
    schedule: initialSchedule,
    scheduleMeta: initialScheduleMeta,
    liveProjection: false,
    liveStatus: "",
    currentView: null
  };

  function money(value) {
    return `$${value}`;
  }

  function plural(count, singular, pluralWord = `${singular}s`) {
    return `${count} ${count === 1 ? singular : pluralWord}`;
  }

  function initials(name) {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function resolveTeam(teamName) {
    return teamLookup.get(normalize(teamName));
  }

  function slugify(value) {
    return normalize(value).replace(/\s+/g, "-");
  }

  function getPlayerTheme(player) {
    const colors = (player.nationalities || [])
      .flatMap((nationality) => COUNTRY_COLORS[nationality.name] || [])
      .filter(Boolean);
    return {
      c1: colors[0] || "#2454d6",
      c2: colors[1] || colors[0] || "#1ea66a"
    };
  }

  function groupLabel(group) {
    if (group === "N/A" || group === "TBD") return group;
    return `G${group}`;
  }

  function groupRank(group) {
    const index = GROUP_ORDER.indexOf(group);
    return index === -1 ? GROUP_ORDER.length : index;
  }

  function formatKickoff(kickoff) {
    if (!kickoff) return "TBD";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(new Date(kickoff));
  }

  function dateKeyInEt(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}${values.month}${values.day}`;
  }

  function dateLabelFromKey(dateKey) {
    if (!dateKey) return "Today";
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

  function timestampEt(date = new Date()) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(date);
  }

  function flagMarkup(item) {
    if (item.flagImage) {
      return `<img class="inline-flag flag-img" src="${escapeHtml(item.flagImage)}" alt="" loading="lazy" decoding="async">`;
    }
    const flagCode = FLAG_CODES[item.name];
    if (flagCode) {
      return `<img class="inline-flag flag-img" src="https://flagcdn.com/w80/${escapeHtml(flagCode)}.png" alt="" loading="lazy" decoding="async">`;
    }
    return `<span class="inline-flag flag-emoji" aria-hidden="true"><span class="flag-emoji-glyph">${escapeHtml(item.flag)}</span></span>`;
  }

  function resultCode(score, opponentScore) {
    if (score > opponentScore) return "W";
    if (score < opponentScore) return "L";
    return "D";
  }

  function canonicalTeamName(teamName) {
    return resolveTeam(teamName)?.name || teamName;
  }

  function completedResultIds() {
    return new Set(results.map((result) => result.sourceEventId).filter(Boolean));
  }

  function projectedResultsFromSchedule(games) {
    const completedIds = completedResultIds();
    const projected = [];

    games.forEach((game) => {
      const isLive = game.status?.state === "in";
      const isNewFinal = game.status?.completed && !completedIds.has(game.id);
      if (!isLive && !isNewFinal) return;

      const competitors = game.competitors || [];
      if (competitors.length !== 2) return;
      const [home, away] = competitors;

      [[home, away], [away, home]].forEach(([team, opponent]) => {
        projected.push({
          team: canonicalTeamName(team.team),
          stage: game.stage || "Groups",
          result: resultCode(Number(team.score || 0), Number(opponent.score || 0)),
          advanceBonus: false,
          opponent: canonicalTeamName(opponent.team),
          score: Number(team.score || 0),
          opponentScore: Number(opponent.score || 0),
          sourceEventId: game.id,
          playedAt: game.kickoff,
          projected: isLive
        });
      });
    });

    return projected;
  }

  function computeTeamScores(sourceResults = results) {
    const scores = new Map(
      teams.map((team) => [
        team.name,
        {
          points: 0,
          matches: 0,
          advanceBonuses: 0,
          eliminated: false
        }
      ])
    );

    sourceResults.forEach((result) => {
      const team = resolveTeam(result.team);
      if (!team) return;

      const score = scores.get(team.name);
      const stage = result.stage || "Groups";
      const multiplier = STAGE_MULTIPLIERS[stage] || 1;
      const resultPoints = RESULT_POINTS[result.result] ?? 0;
      const bonus = result.advanceBonus ? 1 : 0;

      score.points += resultPoints * multiplier + bonus;
      score.matches += result.result ? 1 : 0;
      score.advanceBonuses += bonus;
      score.eliminated = score.eliminated || result.eliminated === true || result.alive === false;
    });

    return scores;
  }

  function computeGroupStandings(sourceResults = results) {
    const standings = new Map(
      teams.map((team) => [
        team.name,
        {
          points: 0,
          goalDifference: 0
        }
      ])
    );

    sourceResults.forEach((result) => {
      const team = resolveTeam(result.team);
      if (!team || (result.stage || "Groups") !== "Groups") return;

      const standing = standings.get(team.name);
      standing.points += RESULT_POINTS[result.result] ?? 0;

      const score = Number(result.score);
      const opponentScore = Number(result.opponentScore);
      if (Number.isFinite(score) && Number.isFinite(opponentScore)) {
        standing.goalDifference += score - opponentScore;
      }
    });

    return standings;
  }

  function compareTeamsByGroupStanding(a, b, groupStandings) {
    const aStanding = groupStandings.get(a.name) || { points: 0, goalDifference: 0 };
    const bStanding = groupStandings.get(b.name) || { points: 0, goalDifference: 0 };
    return (
      bStanding.points - aStanding.points ||
      bStanding.goalDifference - aStanding.goalDifference ||
      a.name.localeCompare(b.name)
    );
  }

  function enrichPlayers(teamScores) {
    return players.map((player) => {
      const picks = (player.picks || []).map((pick) => ({
        original: pick,
        team: resolveTeam(pick)
      }));
      const knownPicks = picks.filter((pick) => pick.team).map((pick) => pick.team);
      const unknownPicks = picks.filter((pick) => !pick.team).map((pick) => pick.original);
      const budgetUsed = knownPicks.reduce((sum, team) => sum + team.price, 0);
      const tier1Count = knownPicks.filter((team) => team.tier === 1).length;
      const tier3Count = knownPicks.filter((team) => team.tier === 3).length;
      const points = knownPicks.reduce((sum, team) => sum + (teamScores.get(team.name)?.points || 0), 0);
      const aliveCount = knownPicks.filter((team) => !teamScores.get(team.name)?.eliminated).length;
      const tier1Selection = knownPicks.find((team) => team.tier === 1) || null;

      return {
        ...player,
        knownPicks,
        unknownPicks,
        budgetUsed,
        tier1Count,
        tier3Count,
        points,
        aliveCount,
        tier1Selection
      };
    });
  }

  function buildPickMap(enrichedPlayers) {
    const pickMap = new Map(teams.map((team) => [team.name, []]));
    enrichedPlayers.forEach((player) => {
      player.knownPicks.forEach((team) => {
        pickMap.get(team.name).push(player);
      });
    });
    return pickMap;
  }

  function rankMapFor(sourcePlayers) {
    return new Map(sortedLeaderboardPlayers(sourcePlayers).map((player, index) => [player.slug, index + 1]));
  }

  function leaderGap(player, sortedPlayers) {
    const leader = sortedPlayers[0];
    if (!leader || player.slug === leader.slug) return 0;
    return Math.max(0, leader.points - player.points);
  }

  function bestPickFor(player, teamScores) {
    return player.knownPicks
      .map((team) => ({ team, points: teamScores.get(team.name)?.points || 0 }))
      .sort((a, b) => b.points - a.points || b.team.price - a.team.price || a.team.name.localeCompare(b.team.name))[0] || null;
  }

  function worstPickFor(player, teamScores) {
    return player.knownPicks
      .map((team) => ({ team, points: teamScores.get(team.name)?.points || 0 }))
      .sort((a, b) => a.points - b.points || b.team.price - a.team.price || a.team.name.localeCompare(b.team.name))[0] || null;
  }

  function teamPoints(team, teamScores) {
    return teamScores.get(team.name)?.points || 0;
  }

  function teamStatus(team, teamScores) {
    return teamScores.get(team.name)?.eliminated ? "Out" : "Alive";
  }

  function teamValue(team, teamScores) {
    const points = teamPoints(team, teamScores);
    if (team.price <= 0) return points > 0 ? points : 0;
    return points / team.price;
  }

  function ownershipCount(team, pickMap) {
    return (pickMap.get(team.name) || []).length;
  }

  function riskProfile(player, pickMap, teamScores) {
    if (player.pending || player.knownPicks.length === 0) return "Pending";
    const avgOwnership = player.knownPicks.reduce((sum, team) => sum + ownershipCount(team, pickMap), 0) / player.knownPicks.length;
    const zeroPointCount = player.knownPicks.filter((team) => teamPoints(team, teamScores) === 0 && team.price >= 20).length;
    if (player.aliveCount <= Math.max(3, Math.floor(player.knownPicks.length * 0.45)) || zeroPointCount >= 3) return "In trouble";
    if (avgOwnership >= 4.5) return "Chalky";
    if (avgOwnership <= 2.2) return "Differential";
    return player.tier1Selection && teamPoints(player.tier1Selection, teamScores) > 0 ? "High upside" : "Balanced";
  }

  function teamValueLabel(team, teamScores, pickMap) {
    const points = teamPoints(team, teamScores);
    const picked = ownershipCount(team, pickMap);
    if (!picked) return points > 0 ? "Differential nobody owns" : "Unowned";
    if (team.price >= 35 && points === 0) return "Expensive flop";
    if (team.price <= 10 && points >= 3) return "Best bargain";
    if (picked >= 6 && points > 0) return "Chalk paying off";
    if (points > 0) return "Value pick";
    return "Waiting";
  }

  function resultRowsForTeam(team) {
    return results.filter((result) => resolveTeam(result.team)?.name === team.name);
  }

  function teamRecord(team) {
    return resultRowsForTeam(team).reduce((record, result) => {
      if (result.result === "W") record.w += 1;
      if (result.result === "D") record.d += 1;
      if (result.result === "L") record.l += 1;
      return record;
    }, { w: 0, d: 0, l: 0 });
  }

  function scheduleRowsForTeam(team) {
    return state.schedule.filter((game) => game.competitors.some((competitor) => resolveTeam(competitor.team)?.name === team.name));
  }

  function playerRouteSummary(player, teamScores) {
    if (player.pending) return "Waiting on picks before the route up the table is clear.";
    const best = bestPickFor(player, teamScores);
    const tierOne = player.tier1Selection;
    if (best && best.points > 0) {
      return `Best route up the table: needs ${best.team.name}${tierOne && tierOne.name !== best.team.name ? ` and ${tierOne.name}` : ""} to keep winning.`;
    }
    if (tierOne) return `Best route up the table: needs ${tierOne.name} to start paying off.`;
    return "Best route up the table: needs the lower-tier picks to create separation.";
  }

  function teamImpactSummary(team, pickMap) {
    const pickedBy = pickMap.get(team.name) || [];
    if (!pickedBy.length) return `${team.name} is a pure differential: no one owns it.`;
    return `Every point for ${team.name} helps ${pickedBy.map((player) => player.name).join(", ")}.`;
  }

  function validateData(enrichedPlayers, sourceResults = results) {
    const warnings = [];

    enrichedPlayers.forEach((player) => {
      if (!player.image) {
        warnings.push({ level: "warn", text: `${player.name} is missing an image path.` });
      }

      player.unknownPicks.forEach((pick) => {
        warnings.push({ level: "error", text: `${player.name} has an unknown team pick: ${pick}.` });
      });

      if (player.pending || player.knownPicks.length === 0) return;

      if (player.budgetUsed > BUDGET) {
        warnings.push({ level: "error", text: `${player.name} is over budget at ${money(player.budgetUsed)}.` });
      }

      if (player.tier1Count > 1) {
        warnings.push({ level: "error", text: `${player.name} has ${player.tier1Count} Tier 1 teams.` });
      }

      if (player.tier3Count < 3) {
        warnings.push({ level: "error", text: `${player.name} has only ${player.tier3Count} Tier 3 teams.` });
      }
    });

    sourceResults.forEach((result, index) => {
      if (!resolveTeam(result.team)) {
        warnings.push({ level: "error", text: `Result ${index + 1} references an unknown team: ${result.team}.` });
      }
      if (result.result && !Object.prototype.hasOwnProperty.call(RESULT_POINTS, result.result)) {
        warnings.push({ level: "error", text: `Result ${index + 1} has an unknown result code: ${result.result}.` });
      }
      if (result.stage && !Object.prototype.hasOwnProperty.call(STAGE_MULTIPLIERS, result.stage)) {
        warnings.push({ level: "error", text: `Result ${index + 1} has an unknown stage: ${result.stage}.` });
      }
    });

    if (warnings.length) {
      console.groupCollapsed("Bomboclats data checks");
      warnings.forEach((warning) => {
        console.warn(`[${warning.level}] ${warning.text}`);
      });
      console.groupEnd();
    }

    return warnings;
  }

  function renderSummary(enrichedPlayers, pickMap) {
    const pickedTeams = [...pickMap.values()].filter((pickedBy) => pickedBy.length > 0).length;
    const topTeam = [...pickMap.entries()]
      .map(([teamName, pickedBy]) => ({ team: resolveTeam(teamName), count: pickedBy.length }))
      .sort((a, b) => b.count - a.count || b.team.price - a.team.price)[0];

    const cards = [
      { label: "Players", value: players.length },
      { label: "Picked Teams", value: `${pickedTeams}/${teams.length}` },
      {
        label: "Most Picked",
        valueHtml: topTeam && topTeam.count ? `${flagMarkup(topTeam.team)} ${escapeHtml(topTeam.team.name)} (${topTeam.count})` : "None"
      }
    ];

    document.getElementById("leaderboard-summary").innerHTML = cards
      .map((card) => `
        <article class="summary-card">
          <span>${escapeHtml(card.label)}</span>
          <strong>${card.valueHtml || escapeHtml(card.value)}</strong>
        </article>
      `)
      .join("");
  }

  function renderHeaderStatus() {
    const statusEl = document.getElementById("header-status");
    if (!statusEl) return;

    statusEl.className = "header-emblems";
    statusEl.setAttribute("aria-label", "FIFA World Cup 2026 mark");
    statusEl.innerHTML = worldCupMarkMarkup();
  }

  function worldCupMarkMarkup(modifier = "") {
    const className = modifier ? ` fifa26-logo--${modifier}` : "";
    return `
      <span class="fifa26-logo${className}" aria-hidden="true">
        <img class="fifa26-img" src="assets/world-cup-2026-logo-crop.png" alt="" loading="eager" decoding="async">
      </span>
    `;
  }

  function renderCommandCenter(enrichedPlayers, teamScores, pickMap) {
    const sorted = sortedLeaderboardPlayers(enrichedPlayers);
    const leader = sorted[0];
    const second = sorted[1];
    const gap = leader && second ? leader.points - second.points : 0;
    const podium = sorted.slice(0, 3);
    const alivePickedTeams = teams.filter((team) => ownershipCount(team, pickMap) > 0 && !teamScores.get(team.name)?.eliminated).length;
    const topTeam = [...pickMap.entries()]
      .map(([teamName, pickedBy]) => ({ team: resolveTeam(teamName), pickedBy }))
      .filter((item) => item.team)
      .sort((a, b) => b.pickedBy.length - a.pickedBy.length || b.team.price - a.team.price)[0];
    const headline = leader && second
      ? `${leader.name} leads by ${gap} ${gap === 1 ? "point" : "points"}, with ${second.name} chasing.`
      : "The table is still taking shape.";

    document.getElementById("command-center").innerHTML = leader ? `
      <article class="command-card">
        <div class="command-main">
          <p class="eyebrow">Pool Command Center</p>
          <h3>${escapeHtml(headline)}</h3>
          <div class="leader-lockup">
            ${avatarMarkup(leader, "hero")}
            <div>
              <span>Current Leader</span>
              <strong>${escapeHtml(leader.name)}</strong>
            </div>
            <b>${leader.points}<small>pts</small></b>
          </div>
        </div>
        <div class="podium-panel" aria-label="Top three podium">
          ${podium.map((player, index) => `
            <button class="podium-step podium-${index + 1}" type="button" data-player-link="${escapeHtml(player.slug)}">
              <span>#${index + 1}</span>
              ${avatarMarkup(player, "mini")}
              <strong>${escapeHtml(player.name)}</strong>
              <b>${player.points} pts</b>
            </button>
          `).join("")}
        </div>
        <div class="command-stats">
          <div><span>Gap to 2nd</span><strong>${gap}</strong></div>
          <div><span>Alive Picked Teams</span><strong>${alivePickedTeams}</strong></div>
          <div><span>Most Owned</span><strong>${topTeam ? `${flagMarkup(topTeam.team)} ${escapeHtml(topTeam.team.name)}` : "None"}</strong></div>
          <div><span>Last Updated</span><strong>${escapeHtml(state.scheduleMeta.lastUpdated || resultsMeta.lastUpdated || "Awaiting update")}</strong></div>
        </div>
      </article>
    ` : "";
  }

  function renderInsightCards(enrichedPlayers, teamScores, pickMap) {
    const sorted = sortedLeaderboardPlayers(enrichedPlayers);
    const leader = sorted[0];
    const second = sorted[1];
    const allPickedTeams = teams.filter((team) => ownershipCount(team, pickMap) > 0);
    const bestValue = [...allPickedTeams].sort((a, b) => teamValue(b, teamScores) - teamValue(a, teamScores) || teamPoints(b, teamScores) - teamPoints(a, teamScores))[0];
    const worstSpend = [...allPickedTeams].sort((a, b) => teamPoints(a, teamScores) - teamPoints(b, teamScores) || b.price - a.price)[0];
    const mostAlive = [...enrichedPlayers].filter((player) => !player.pending).sort((a, b) => b.aliveCount - a.aliveCount || b.points - a.points)[0];
    const mostPicked = [...allPickedTeams].sort((a, b) => ownershipCount(b, pickMap) - ownershipCount(a, pickMap) || b.price - a.price)[0];
    const bestUnpicked = teams.filter((team) => ownershipCount(team, pickMap) === 0).sort((a, b) => teamPoints(b, teamScores) - teamPoints(a, teamScores) || b.price - a.price)[0];
    const insights = [
      leader && second ? { label: "Closest Race", title: `${second.name} is ${leader.points - second.points} back`, meta: `${leader.name} still controls the table.` } : null,
      bestValue ? { label: "Value Pick", title: `${bestValue.name} is the bargain`, meta: `${teamPoints(bestValue, teamScores)} pts on a ${money(bestValue.price)} price.` } : null,
      mostPicked ? { label: "Chalk Watch", title: `${mostPicked.name} is everywhere`, meta: `${ownershipCount(mostPicked, pickMap)} players own it.` } : null,
      bestUnpicked && teamPoints(bestUnpicked, teamScores) > 0 ? { label: "Differential Alert", title: `${bestUnpicked.name} is unowned`, meta: `${teamPoints(bestUnpicked, teamScores)} pts sitting on the board.` } : null,
      mostAlive ? { label: "Still Alive", title: `${mostAlive.name} has ${mostAlive.aliveCount} alive`, meta: "Most routes still open." } : null,
      worstSpend ? { label: "Danger Zone", title: `${worstSpend.name} needs a spark`, meta: `${teamPoints(worstSpend, teamScores)} pts at ${money(worstSpend.price)}.` } : null
    ].filter(Boolean).slice(0, 6);

    document.getElementById("insight-grid").innerHTML = insights.map((card) => `
      <article class="insight-card">
        <span>${escapeHtml(card.label)}</span>
        <strong>${escapeHtml(card.title)}</strong>
        <p>${escapeHtml(card.meta)}</p>
      </article>
    `).join("");
  }

  function scheduleStatus(game) {
    if (game.status?.completed) return "Final";
    if (game.status?.state === "in") {
      return game.status.shortDetail || game.status.displayClock || "Live";
    }
    return formatKickoff(game.kickoff);
  }

  function livePointsForCompetitor(game, competitor) {
    if (!(game.status?.state === "in" || game.status?.completed)) return null;
    const opponent = game.competitors.find((item) => item !== competitor);
    if (!opponent) return null;
    return RESULT_POINTS[resultCode(Number(competitor.score || 0), Number(opponent.score || 0))] || 0;
  }

  function matchImpactText(game, pickMap) {
    const owned = game.competitors
      .map((competitor) => {
        const team = resolveTeam(competitor.team);
        return { team, count: team ? ownershipCount(team, pickMap) : 0, competitor };
      })
      .filter((item) => item.team);
    const total = owned.reduce((sum, item) => sum + item.count, 0);
    if (!total) return "Dead game for the pool";
    const sorted = [...owned].sort((a, b) => b.count - a.count);
    const leader = sorted[0];
    const other = sorted[1];
    if (leader.count >= 4 && other?.count >= 3) return "Massive swing game";
    if (leader.count >= 3) return `${leader.count} players backing ${leader.team.name}`;
    return "Pool swing in play";
  }

  function scheduleTeamMarkup(game, competitor, pickMap, showScore) {
    const team = resolveTeam(competitor.team);
    const pickedBy = team ? pickMap.get(team.name) || [] : [];
    const item = team || { name: competitor.team, flag: "" };
    const teamNameMarkup = team
      ? `<button class="score-team-link" type="button" data-team-link="${escapeHtml(team.name)}" aria-label="View ${escapeHtml(team.name)} team card">${flagMarkup(item)} <span class="country-name">${escapeHtml(competitor.team)}</span></button>`
      : `<strong>${escapeHtml(competitor.team)}</strong>`;
    const pickerMarkup = pickedBy.length
      ? pickedBy.map((player) => `<button class="score-picker-name" type="button" data-player-link="${escapeHtml(player.slug)}">${escapeHtml(player.name)}</button>`).join("")
      : `<span class="score-picker-empty">Unpicked</span>`;
    return `
      <div class="score-team${competitor.winner ? " is-winner" : ""}">
        <div class="score-team-info">
          <div class="score-team-line">
            ${teamNameMarkup}
            <span class="score-picker-list" aria-label="${escapeHtml(pickedBy.length ? `Picked by ${pickedBy.map((player) => player.name).join(", ")}` : "Unpicked")}">${pickerMarkup}</span>
          </div>
        </div>
        <b>${showScore ? escapeHtml(competitor.score) : "-"}</b>
      </div>
    `;
  }

  function renderDailySchedule(pickMap) {
    const scheduleEl = document.getElementById("daily-scoreboard");
    const liveCount = state.schedule.filter((game) => game.status?.state === "in").length;
    const slateLabel = liveCount ? `${plural(liveCount, "live match", "live matches")}` : plural(state.schedule.length, "game", "games");
    const gamesMarkup = state.schedule.length
      ? state.schedule.map((game) => {
          const showScore = game.status?.state === "in" || game.status?.completed;
          const statusClass = game.status?.state === "in" ? " is-live" : game.status?.completed ? " is-final" : "";
          return `
            <article class="score-card${statusClass}">
              <div class="score-card-top">
                <span>${escapeHtml(game.stage || "Groups")}</span>
                <strong>${escapeHtml(scheduleStatus(game))}</strong>
              </div>
              <div class="score-matchup">
                ${game.competitors.map((competitor) => scheduleTeamMarkup(game, competitor, pickMap, showScore)).join("")}
              </div>
            </article>
          `;
        }).join("")
      : `<div class="empty-state">No games listed for today.</div>`;

    scheduleEl.innerHTML = `
      <article class="scoreboard-panel">
        <div class="scoreboard-head">
          <div>
            <p class="eyebrow">Games</p>
            <h3>Today</h3>
          </div>
          <div>
            <strong>${escapeHtml(slateLabel)}</strong>
          </div>
        </div>
        <div class="scoreboard-grid">${gamesMarkup}</div>
      </article>
    `;
    renderHeaderStatus();
  }

  function renderTodayHeadline(enrichedPlayers) {
    const headlineEl = document.getElementById("today-headline");
    if (!headlineEl) return;

    const player = enrichedPlayers.find((item) => item.slug === "aaron");
    if (!player || player.pending) {
      headlineEl.innerHTML = "";
      return;
    }
    const mike = enrichedPlayers.find((item) => item.slug === "mike");
    const overBudget = Math.max(0, player.budgetUsed - BUDGET);
    const mikeOverBudget = mike ? Math.max(0, mike.budgetUsed - BUDGET) : 0;

    const pickMarkup = player.knownPicks.map((team) => `
      <span class="headline-pick">${flagMarkup(team)} <span class="country-name">${escapeHtml(team.name)}</span></span>
    `).join("");

    headlineEl.innerHTML = `
      <article class="headline-card">
        <div class="headline-main">
          <p class="eyebrow">Breaking News</p>
          <h3>Aaron adds Spain, joins Mike in the over-budget household</h3>
          <p>Spain has entered Aaron's squad, lifting her to ${money(player.budgetUsed)} and ${money(overBudget)} over budget. Classic married-couple math: two squads, ${mikeOverBudget ? `two overages` : `one overage`}, and one very brave relationship with arithmetic.</p>
          <div class="headline-picks" aria-label="Aaron's picks">${pickMarkup}</div>
        </div>
        <div class="headline-player">
          ${avatarMarkup(player, "mini")}
          <strong>${escapeHtml(player.name)}</strong>
          <span>${player.knownPicks.length} teams · ${money(player.budgetUsed)}</span>
          <em>${money(overBudget)} over budget</em>
        </div>
      </article>
    `;
  }

  function compareLeaderboardPlayers(a, b) {
    if (b.points !== a.points) return b.points - a.points;
    if (a.pending !== b.pending) return a.pending ? 1 : -1;
    if (b.budgetUsed !== a.budgetUsed) return b.budgetUsed - a.budgetUsed;
    return a.name.localeCompare(b.name);
  }

  function sortedLeaderboardPlayers(sourcePlayers) {
    return [...sourcePlayers].sort(compareLeaderboardPlayers);
  }

  function renderLeaderboard(officialPlayers, livePlayers, teamScores) {
    const officialBySlug = new Map(officialPlayers.map((player) => [player.slug, player]));
    const officialRankBySlug = new Map(sortedLeaderboardPlayers(officialPlayers).map((player, index) => [player.slug, index + 1]));
    const isLiveMode = state.leaderboardMode === "live";
    const sourcePlayers = isLiveMode ? livePlayers : officialPlayers;
    const sorted = sortedLeaderboardPlayers(sourcePlayers);
    const leader = sorted[0];

    const rows = sorted.map((player, index) => {
      const rank = index + 1;
      const officialRank = officialRankBySlug.get(player.slug);
      const movement = isLiveMode && officialRank ? officialRank - rank : 0;
      const movementMarkup = movement
        ? `<span class="rank-movement ${movement > 0 ? "up" : "down"}" aria-label="${escapeHtml(`${player.name} moved ${movement > 0 ? "up" : "down"} ${Math.abs(movement)} ${Math.abs(movement) === 1 ? "spot" : "spots"} in the live leaderboard`)}"><span aria-hidden="true">${movement > 0 ? "&#9650;" : "&#9660;"}</span>${Math.abs(movement)}</span>`
        : "";
      const officialPlayer = officialBySlug.get(player.slug);
      const delta = isLiveMode && officialPlayer ? player.points - officialPlayer.points : 0;
      const deltaMarkup = delta
        ? `<span class="point-delta ${delta > 0 ? "positive" : "negative"}">${delta > 0 ? "+" : ""}${delta} live</span>`
        : "";
      const tier1Selection = player.tier1Selection
        ? `<span class="leader-tier-one">${flagMarkup(player.tier1Selection)} <span class="country-name">${escapeHtml(player.tier1Selection.name)}</span></span>`
        : `<span class="small-muted">No Tier 1</span>`;
      const status = player.pending ? "Picks pending" : `${player.aliveCount} alive · ${player.knownPicks.length} teams`;
      const gap = leaderGap(player, sorted);
      return `
        <button class="standings-row ${rank <= 3 ? `is-podium is-rank-${rank}` : ""}" type="button" data-player-link="${escapeHtml(player.slug)}" data-player-row="${escapeHtml(player.slug)}" aria-label="View ${escapeHtml(player.name)} profile">
          <span class="rank-badge">${rank}</span>
          ${avatarMarkup(player, "mini")}
          <span class="standings-person">
            <strong>${escapeHtml(player.name)}</strong>
            <small>${escapeHtml(status)}</small>
          </span>
          <span class="standings-context">
            ${player.slug === leader?.slug ? `<span class="leader-gap is-leader">Leader</span>` : `<span class="leader-gap">${gap} back</span>`}
            ${tier1Selection}
          </span>
          <span class="standings-points">
            <strong>${player.points}</strong>
            <small>pts</small>
            ${deltaMarkup}
            ${movementMarkup}
          </span>
        </button>
      `;
    });

    const liveNote = state.liveProjection
      ? "Live view projects active scores."
      : "Official standings.";

    document.getElementById("leaderboard-table").innerHTML = `
      <article class="standings-panel">
        <div class="standings-top">
          <div>
            <p class="eyebrow">Standings</p>
            <h3>Table</h3>
          </div>
          <div class="segmented-control ranking-toggle" role="group" aria-label="Leaderboard mode">
            <button class="segment ${!isLiveMode ? "is-active" : ""}" type="button" data-leaderboard-mode="official" aria-pressed="${String(!isLiveMode)}">Official</button>
            <button class="segment ${isLiveMode ? "is-active" : ""}" type="button" data-leaderboard-mode="live" aria-pressed="${String(isLiveMode)}">Live</button>
          </div>
        </div>
        <div class="standings-list">${rows.join("")}</div>
        <p class="standings-note">${escapeHtml(liveNote)}</p>
      </article>
    `;
    document.querySelector(".standings-list")?.scrollTo({ top: 0 });

  }

  function avatarMarkup(player, size = "full") {
    if (!player.image) {
      return `<span class="${size === "mini" ? "mini-avatar" : "initials-avatar"}">${escapeHtml(initials(player.name))}</span>`;
    }

    const className = size === "mini" ? "mini-avatar" : "";
    return `<img class="${className}" src="${escapeHtml(player.image)}" alt="${escapeHtml(player.name)} headshot" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'), {className: '${size === "mini" ? "mini-avatar" : "initials-avatar"}', textContent: '${escapeHtml(initials(player.name))}'}));">`;
  }

  function renderPlayers(enrichedPlayers, teamScores, pickMap) {
    const ranked = sortedLeaderboardPlayers(enrichedPlayers);
    const ranks = rankMapFor(enrichedPlayers);
    const filtered = ranked.filter((player) => {
      const rank = ranks.get(player.slug);
      const risk = riskProfile(player, pickMap, teamScores);
      if (state.playerFilter === "podium") return rank <= 3;
      if (state.playerFilter === "chasing") return rank > 3 && !player.pending;
      if (state.playerFilter === "trouble") return risk === "In trouble";
      if (state.playerFilter === "pending") return player.pending;
      return true;
    }).sort((a, b) => {
      if (state.playerSort === "alpha") return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      if (state.playerSort === "alive") return b.aliveCount - a.aliveCount || compareLeaderboardPlayers(a, b);
      if (state.playerSort === "budget") return b.budgetUsed - a.budgetUsed || compareLeaderboardPlayers(a, b);
      return compareLeaderboardPlayers(a, b);
    });

    document.getElementById("players-grid").innerHTML = filtered.length
      ? filtered
      .map((player) => {
        const theme = getPlayerTheme(player);
        const focused = player.slug === state.focusedPlayerSlug ? " is-focused" : "";
        const rank = ranks.get(player.slug);
        const gap = leaderGap(player, ranked);
        const risk = riskProfile(player, pickMap, teamScores);
        const nationalityChips = (player.nationalities || [])
          .map((nationality) => `<span class="chip country-chip">${flagMarkup(nationality)} <span class="country-name">${escapeHtml(nationality.name)}</span></span>`)
          .join("");
        const picksMarkup = player.pending || player.knownPicks.length === 0
          ? `<span class="status-pill">Picks pending</span>`
          : player.knownPicks.map((team) => {
              const score = teamScores.get(team.name);
              const eliminated = score?.eliminated ? " is-eliminated" : "";
              return `
                <button class="team-pill pick-button${eliminated}" type="button" data-team-link="${escapeHtml(team.name)}" data-player-link="${escapeHtml(player.slug)}" aria-label="View ${escapeHtml(team.name)} team card picked by ${escapeHtml(player.name)}">
                  ${flagMarkup(team)} <span class="country-name">${escapeHtml(team.name)}</span>
                  <span class="price">${money(team.price)}</span>
                  <span class="pick-points">${score?.points || 0} pts</span>
                </button>
              `;
            }).join("");
        const bestPick = player.knownPicks
          .map((team) => ({ team, points: teamScores.get(team.name)?.points || 0 }))
          .sort((a, b) => b.points - a.points || b.team.price - a.team.price || a.team.name.localeCompare(b.team.name))[0];
        const spotlightMarkup = player.pending || !player.knownPicks.length
          ? `<div class="player-spotlights"><span class="spotlight-item muted"><b>Status</b><strong>Picks pending</strong></span></div>`
          : `
            <div class="player-spotlights">
              <span class="spotlight-item">
                <b>Tier 1</b>
                <strong>${player.tier1Selection ? `${flagMarkup(player.tier1Selection)} ${escapeHtml(player.tier1Selection.name)}` : "None"}</strong>
              </span>
              <span class="spotlight-item">
                <b>Best Pick</b>
                <strong>${bestPick ? `${flagMarkup(bestPick.team)} ${escapeHtml(bestPick.team.name)} · ${bestPick.points} pts` : "None"}</strong>
              </span>
            </div>
          `;

        return `
          <article class="player-card${focused}" id="player-${escapeHtml(player.slug)}" data-player-slug="${escapeHtml(player.slug)}" tabindex="0" style="--c1:${theme.c1};--c2:${theme.c2}">
            <div class="player-head">
              <div class="avatar-wrap">${avatarMarkup(player)}</div>
              <div class="player-title">
                <span class="profile-rank">#${rank}</span>
                <h3>${escapeHtml(player.name)}</h3>
                <div class="nationality-row">${nationalityChips}</div>
              </div>
              <span class="risk-pill">${escapeHtml(risk)}</span>
            </div>
            ${spotlightMarkup}
            <div class="player-metrics">
              <div class="metric"><span class="metric-label">Points</span><strong>${player.points}</strong></div>
              <div class="metric"><span class="metric-label">Gap</span><strong>${gap ? `${gap} back` : "Leader"}</strong></div>
              <div class="metric"><span class="metric-label">Budget</span><strong>${money(player.budgetUsed)}</strong></div>
              <div class="metric"><span class="metric-label">Alive</span><strong>${player.aliveCount}</strong></div>
            </div>
            <p class="picks-title">Picks</p>
            <div class="pill-row">${picksMarkup}</div>
          </article>
        `;
      })
      .join("")
      : `<div class="empty-state">No players match this filter.</div>`;
  }

  function teamCardMarkup(team, teamScores, pickMap) {
    const pickedBy = pickMap.get(team.name) || [];
    const score = teamScores.get(team.name);
    const isFocused = normalize(team.name) === normalize(state.focusedTeamName);
    const record = teamRecord(team);
    const valueLabel = teamValueLabel(team, teamScores, pickMap);
    const pickedMarkup = pickedBy.length
      ? pickedBy.map((player) => {
          const selected = isFocused && player.slug === state.focusedPlayerSlug ? " is-selected" : "";
          return `<button class="chip picked-player-chip${selected}" type="button" data-player-link="${escapeHtml(player.slug)}" aria-label="View ${escapeHtml(player.name)} player profile">${escapeHtml(player.name)}</button>`;
        }).join("")
      : `<span class="small-muted">Unpicked</span>`;
    return `
      <article class="team-card${isFocused ? " is-focused" : ""}" id="team-${escapeHtml(slugify(team.name))}" data-team-name="${escapeHtml(team.name)}">
        <div class="team-top">
          <span class="team-flag" aria-hidden="true">${flagMarkup(team)}</span>
          <div>
            <h3>${escapeHtml(team.name)}</h3>
            <p class="team-meta">Tier ${team.tier} / Group ${escapeHtml(team.group)}</p>
          </div>
          <span class="team-price">${money(team.price)}</span>
        </div>
        <p class="team-story">${escapeHtml(valueLabel)}</p>
        <div class="team-stats">
          <div class="team-stat"><span>Picked</span><strong>${pickedBy.length}</strong></div>
          <div class="team-stat"><span>Points</span><strong>${score?.points || 0}</strong></div>
          <div class="team-stat"><span>W-D-L</span><strong>${record.w}-${record.d}-${record.l}</strong></div>
          <div class="team-stat"><span>Status</span><strong>${score?.eliminated ? "Out" : "Alive"}</strong></div>
        </div>
        <p class="picked-label">Picked by</p>
        <div class="picked-row">${pickedMarkup}</div>
      </article>
    `;
  }

  function renderTeams(enrichedPlayers, teamScores, pickMap) {
    const query = normalize(state.search);
    const groupStandings = computeGroupStandings(results);
    const filteredTeams = teams.filter((team) => {
      const pickedBy = pickMap.get(team.name) || [];
      if (state.teamFilter === "picked" && pickedBy.length === 0) return false;
      if (!query) return true;
      const haystack = normalize([
        team.name,
        team.group,
        `group ${team.group}`,
        `tier ${team.tier}`,
        ...pickedBy.map((player) => player.name)
      ].join(" "));
      return haystack.includes(query);
    });

    const sortedTeams = [...filteredTeams].sort((a, b) => {
      if (state.teamView === "ownership") {
        return ownershipCount(b, pickMap) - ownershipCount(a, pickMap) || teamPoints(b, teamScores) - teamPoints(a, teamScores) || a.name.localeCompare(b.name);
      }
      if (state.teamView === "value") {
        return teamValue(b, teamScores) - teamValue(a, teamScores) || teamPoints(b, teamScores) - teamPoints(a, teamScores) || a.name.localeCompare(b.name);
      }
      return groupRank(a.group) - groupRank(b.group) || compareTeamsByGroupStanding(a, b, groupStandings);
    });

    const grouped = sortedTeams.reduce((groups, team) => {
      const key = team.group || "TBD";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(team);
      return groups;
    }, new Map());

    const boardMarkup = state.teamView === "group"
      ? [...grouped.entries()].map(([group, groupTeams]) => `
          <section class="team-group" aria-labelledby="group-${escapeHtml(slugify(group))}">
            <div class="group-header">
              <div>
                <p class="eyebrow">${group === "N/A" || group === "TBD" ? "Other" : "Group"}</p>
                <h3 id="group-${escapeHtml(slugify(group))}">${escapeHtml(group === "N/A" ? "No Group" : group === "TBD" ? "Group TBD" : `Group ${group}`)}</h3>
              </div>
              <span>${plural(groupTeams.length, "team")}</span>
            </div>
            <div class="team-card-grid">
              ${groupTeams.map((team) => teamCardMarkup(team, teamScores, pickMap)).join("")}
            </div>
          </section>
        `).join("")
      : `
          <section class="team-group" aria-labelledby="team-view-${escapeHtml(state.teamView)}">
            <div class="group-header">
              <div>
                <p class="eyebrow">${state.teamView === "ownership" ? "Ownership" : "Value"}</p>
                <h3 id="team-view-${escapeHtml(state.teamView)}">${state.teamView === "ownership" ? "Most Owned Teams" : "Best Value Board"}</h3>
              </div>
              <span>${plural(sortedTeams.length, "team")}</span>
            </div>
            <div class="team-card-grid">
              ${sortedTeams.map((team) => teamCardMarkup(team, teamScores, pickMap)).join("")}
            </div>
          </section>
        `;

    document.getElementById("teams-grid").innerHTML = sortedTeams.length
      ? boardMarkup
      : `<div class="empty-state">No teams match this view.</div>`;
  }

  function renderRules(warnings) {
    const steps = [
      ["1", "Pick teams within budget", `Build a squad that stays within ${money(BUDGET)}.`],
      ["2", "Teams earn match points", "Wins, draws, and losses add to each team total."],
      ["3", "Later rounds multiply", "Round of 32 and beyond become much more valuable."],
      ["4", "Advance bonus", "A team gets +1 once when it survives the group stage."],
      ["5", "Payouts", "The top three finishers split the pot."]
    ];
    const selectionRules = [
      ["Budget", `Stay within ${money(BUDGET)}.`],
      ["Tier 1", "0-1 teams allowed."],
      ["Tier 2", "Unlimited selections."],
      ["Tier 3", "Minimum 3 teams required."]
    ];
    const scores = [
      ["Win", "3 pts", ""],
      ["Draw", "1 pt", ""],
      ["Loss", "0 pts", "loss"],
      ["Advance bonus", "+1 pt", "bonus"],
      ["Bronze match", "-", "loss"]
    ];
    const multipliers = Object.entries(STAGE_MULTIPLIERS);
    const payouts = [
      ["Total pot", "$120"],
      ["1st place", "$100"],
      ["2nd place", "$10"],
      ["3rd place", "$10"]
    ];

    const checksMarkup = warnings.length
      ? `<ul class="checks-list">${warnings.map((warning) => `<li class="check-item ${warning.level === "error" ? "error" : ""}">${escapeHtml(warning.text)}</li>`).join("")}</ul>`
      : `<p class="status-pill ok">No data issues detected.</p>`;

    document.getElementById("rules-content").innerHTML = `
      <article class="rule-card rule-hero">
        <p class="eyebrow">How This Pool Works</p>
        <h3>You are not predicting individual matches.</h3>
        <p>Your teams accumulate points as they progress through the World Cup. Pick a portfolio, then cheer for every result that pushes those teams forward.</p>
        <div class="rules-steps">
          ${steps.map(([number, title, text]) => `
            <div class="rule-step">
              <span>${number}</span>
              <strong>${escapeHtml(title)}</strong>
              <p>${escapeHtml(text)}</p>
            </div>
          `).join("")}
        </div>
      </article>
      <article class="rule-card">
        <h3>Selection Rules</h3>
        <ul class="rule-list">
          ${selectionRules.map(([label, value]) => `<li><strong>${label}</strong><span>${value}</span></li>`).join("")}
        </ul>
      </article>
      <article class="rule-card">
        <h3>Scoring</h3>
        ${scores.map(([label, value, className]) => `<div class="score-row ${className}"><strong>${label}</strong><strong>${value}</strong></div>`).join("")}
      </article>
      <article class="rule-card">
        <h3>Payouts</h3>
        <ul class="rule-list">
          ${payouts.map(([label, value]) => `<li><strong>${label}</strong><span>${value}</span></li>`).join("")}
        </ul>
      </article>
      <article class="rule-card">
        <h3>Stage Multipliers</h3>
        <div class="multiplier-grid">
          ${multipliers.map(([stage, multiplier]) => `<div class="multiplier"><span>${stage}</span><strong>x${multiplier}</strong></div>`).join("")}
        </div>
      </article>
      <article class="rule-card">
        <h3>Formula</h3>
        <ul class="rule-list">
          <li><strong>Match</strong><span>result points x stage multiplier</span></li>
          <li><strong>Advance</strong><span>+1 point, one time</span></li>
          <li><strong>Player</strong><span>sum of picked team totals</span></li>
        </ul>
      </article>
      <article class="rule-card checks-card">
        <h3>Data Checks</h3>
        ${checksMarkup}
      </article>
    `;
  }

  function wireTabs() {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        showPanel(tab.dataset.tab);
      });
    });
  }

  function showPanel(panelId) {
    document.querySelectorAll(".tab").forEach((item) => {
      const isActive = item.dataset.tab === panelId;
      item.classList.toggle("is-active", isActive);
      item.setAttribute("aria-selected", String(isActive));
    });
    document.querySelectorAll(".panel").forEach((panel) => {
      panel.classList.toggle("is-active", panel.id === panelId);
    });
  }

  function getStickyOffset() {
    const header = document.querySelector(".site-header");
    const headerHeight = header ? header.getBoundingClientRect().height : 0;
    return headerHeight + 16;
  }

  function scrollToElement(selector) {
    const align = () => {
      const element = document.querySelector(selector);
      if (!element) return;
      const top = element.getBoundingClientRect().top + window.scrollY - getStickyOffset();
      const root = document.documentElement;
      const previousScrollBehavior = root.style.scrollBehavior;
      root.style.scrollBehavior = "auto";
      window.scrollTo(0, Math.max(0, top));
      root.style.scrollBehavior = previousScrollBehavior;
      if (typeof element.focus === "function") {
        element.setAttribute("tabindex", "-1");
        element.focus({ preventScroll: true });
      }
    };

    requestAnimationFrame(() => {
      align();
      window.setTimeout(align, 120);
      window.setTimeout(align, 360);
    });
  }

  function syncTeamFilterControls() {
    document.querySelectorAll("[data-team-filter]").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.teamFilter === state.teamFilter);
    });
    document.querySelectorAll("[data-team-view]").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.teamView === state.teamView);
    });
    const teamFilterSelect = document.getElementById("team-filter");
    if (teamFilterSelect) teamFilterSelect.value = state.teamFilter;
    const teamViewSelect = document.getElementById("team-view");
    if (teamViewSelect) teamViewSelect.value = state.teamView;
    const teamSearch = document.getElementById("team-search");
    if (teamSearch) teamSearch.value = state.search;
  }

  function syncPlayerControls() {
    document.querySelectorAll("[data-player-sort]").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.playerSort === state.playerSort);
    });
    document.querySelectorAll("[data-player-filter]").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.playerFilter === state.playerFilter);
    });
    const playerSortSelect = document.getElementById("player-sort");
    if (playerSortSelect) playerSortSelect.value = state.playerSort;
    const playerFilterSelect = document.getElementById("player-filter");
    if (playerFilterSelect) playerFilterSelect.value = state.playerFilter;
  }

  function wireTeamControls(render) {
    document.querySelectorAll("[data-team-view]").forEach((button) => {
      button.addEventListener("click", () => {
        state.teamView = button.dataset.teamView;
        syncTeamFilterControls();
        render();
      });
    });

    document.querySelectorAll("[data-team-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.teamFilter = button.dataset.teamFilter;
        syncTeamFilterControls();
        render();
      });
    });

    document.getElementById("team-view")?.addEventListener("change", (event) => {
      state.teamView = event.target.value;
      syncTeamFilterControls();
      render();
    });

    document.getElementById("team-filter")?.addEventListener("change", (event) => {
      state.teamFilter = event.target.value;
      syncTeamFilterControls();
      render();
    });

    document.getElementById("team-search")?.addEventListener("input", (event) => {
      state.search = event.target.value;
      render();
    });
  }

  function wirePlayerControls(render) {
    document.querySelectorAll("[data-player-sort]").forEach((button) => {
      button.addEventListener("click", () => {
        state.playerSort = button.dataset.playerSort;
        syncPlayerControls();
        render();
      });
    });

    document.querySelectorAll("[data-player-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.playerFilter = button.dataset.playerFilter;
        syncPlayerControls();
        render();
      });
    });

    document.getElementById("player-sort")?.addEventListener("change", (event) => {
      state.playerSort = event.target.value;
      syncPlayerControls();
      render();
    });

    document.getElementById("player-filter")?.addEventListener("change", (event) => {
      state.playerFilter = event.target.value;
      syncPlayerControls();
      render();
    });
  }

  function wireLeaderboardControls(render) {
    document.addEventListener("click", (event) => {
      const button = event.target.closest("[data-leaderboard-mode]");
      if (!button) return;
      state.leaderboardMode = button.dataset.leaderboardMode;
      render();
    });
  }

  function drawerShell(title, subtitle, body) {
    const drawer = document.getElementById("detail-drawer");
    const ariaTitle = String(title).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    drawer.innerHTML = `
      <div class="drawer-backdrop" data-drawer-close></div>
      <aside class="drawer-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(ariaTitle)}">
        <button class="drawer-close" type="button" data-drawer-close aria-label="Close details">×</button>
        <div class="drawer-brand-strip" aria-hidden="true">
          <span class="drawer-crest-mark">
            <svg viewBox="0 0 92 110" focusable="false">
              <path class="crest-shield" d="M6 4h80v61c0 18.5-12.5 32.4-40 41C18.5 97.4 6 83.5 6 65V4Z" />
              <path class="crest-divider" d="M7 35.5h78" />
              <rect class="drawer-book" x="29" y="10" width="34" height="22" rx="3" />
              <path class="drawer-book-line" d="M46 11v22M34 18h9M49 18h9M34 24h9M49 24h9" />
              <circle class="crest-dot crest-dot-blue" cx="35" cy="48" r="5.8" />
              <circle class="crest-dot crest-dot-blue" cx="57" cy="48" r="5.8" />
              <circle class="crest-dot crest-dot-blue" cx="25" cy="61" r="5.8" />
              <circle class="crest-dot crest-dot-blue" cx="67" cy="61" r="5.8" />
              <path class="crest-diamond-top" d="M46 51 65 71H27L46 51Z" />
              <path class="crest-diamond-bottom" d="M27 71h38L46 91 27 71Z" />
              <circle class="crest-dot crest-dot-white" cx="25" cy="81" r="5.8" />
              <circle class="crest-dot crest-dot-white" cx="36" cy="92" r="5.8" />
              <circle class="crest-dot crest-dot-white" cx="56" cy="92" r="5.8" />
              <circle class="crest-dot crest-dot-white" cx="67" cy="81" r="5.8" />
            </svg>
          </span>
          ${worldCupMarkMarkup("drawer")}
        </div>
        <div class="drawer-head">
          <p class="eyebrow">${escapeHtml(subtitle)}</p>
          <h3>${title}</h3>
        </div>
        ${body}
      </aside>
    `;
    drawer.classList.add("is-open");
    drawer.setAttribute("aria-hidden", "false");
    const closeButton = drawer.querySelector(".drawer-close");
    if (closeButton) closeButton.focus({ preventScroll: true });
  }

  function closeDrawer() {
    const drawer = document.getElementById("detail-drawer");
    drawer.classList.remove("is-open");
    drawer.setAttribute("aria-hidden", "true");
  }

  function renderPlayerDrawer(slug) {
    const view = state.currentView;
    if (!view) return;
    const player = view.officialPlayers.find((item) => item.slug === slug);
    if (!player) return;
    const sorted = sortedLeaderboardPlayers(view.officialPlayers);
    const rank = rankMapFor(view.officialPlayers).get(player.slug);
    const gap = leaderGap(player, sorted);
    const best = bestPickFor(player, view.officialTeamScores);
    const tierGroups = [1, 2, 3].map((tier) => {
      const tierPicks = player.knownPicks.filter((team) => team.tier === tier);
      if (!tierPicks.length) return "";
      return `
        <section class="drawer-group">
          <h4>Tier ${tier}</h4>
          <div class="drawer-pick-grid">
            ${tierPicks.map((team) => {
              const score = view.officialTeamScores.get(team.name);
              const picked = ownershipCount(team, view.pickMap);
              return `
                <button class="drawer-pick" type="button" data-team-link="${escapeHtml(team.name)}">
                  ${flagMarkup(team)}
                  <span>${escapeHtml(team.name)}</span>
                  <b>${money(team.price)}</b>
                  <em>${score?.points || 0} pts · ${teamStatus(team, view.officialTeamScores)} · ${picked} owned</em>
                </button>
              `;
            }).join("")}
          </div>
        </section>
      `;
    }).join("");
    const nationality = (player.nationalities || [])
      .map((item) => `<span class="chip country-chip">${flagMarkup(item)} <span class="country-name">${escapeHtml(item.name)}</span></span>`)
      .join("");
    drawerShell(
      escapeHtml(player.name),
      `Rank #${rank} · ${player.points} points`,
      `
        <div class="drawer-profile">
          ${avatarMarkup(player)}
          <div>
            <div class="nationality-row">${nationality}</div>
            <p>${escapeHtml(playerRouteSummary(player, view.officialTeamScores))}</p>
          </div>
        </div>
        <div class="drawer-stats">
          <div><span>Gap</span><strong>${gap ? `${gap} back` : "Leader"}</strong></div>
          <div><span>Budget</span><strong>${money(player.budgetUsed)}</strong></div>
          <div><span>Alive</span><strong>${player.aliveCount}</strong></div>
          <div><span>Tier 1</span><strong>${player.tier1Selection ? player.tier1Selection.name : "None"}</strong></div>
          <div><span>Best Pick</span><strong>${best ? `${best.team.name} (${best.points})` : "None"}</strong></div>
          <div><span>Risk</span><strong>${escapeHtml(riskProfile(player, view.pickMap, view.officialTeamScores))}</strong></div>
        </div>
        ${tierGroups || `<p class="empty-state">No submitted picks yet.</p>`}
        <button class="drawer-action" type="button" data-open-player-tab="${escapeHtml(player.slug)}">Open player card</button>
      `
    );
  }

  function renderTeamDrawer(teamName) {
    const view = state.currentView;
    if (!view) return;
    const team = resolveTeam(teamName);
    if (!team) return;
    const pickedBy = view.pickMap.get(team.name) || [];
    const score = view.officialTeamScores.get(team.name);
    const record = teamRecord(team);
    const resultsMarkup = resultRowsForTeam(team).length
      ? resultRowsForTeam(team).map((result) => `<li><strong>${escapeHtml(result.opponent || "Opponent")}</strong><span>${escapeHtml(result.result || "-")} ${result.score ?? ""}-${result.opponentScore ?? ""}</span></li>`).join("")
      : `<li><strong>Results</strong><span>No completed results listed.</span></li>`;
    const scheduleMarkup = scheduleRowsForTeam(team).map((game) => `<li><strong>${escapeHtml(scheduleStatus(game))}</strong><span>${game.competitors.map((competitor) => escapeHtml(competitor.team)).join(" vs ")}</span></li>`).join("");
    drawerShell(
      `${flagMarkup(team)} ${escapeHtml(team.name)}`,
      `Tier ${team.tier} · Group ${escapeHtml(team.group)}`,
      `
        <p class="drawer-summary">${escapeHtml(teamImpactSummary(team, view.pickMap))}</p>
        <div class="drawer-stats">
          <div><span>Points</span><strong>${score?.points || 0}</strong></div>
          <div><span>Price</span><strong>${money(team.price)}</strong></div>
          <div><span>Picked</span><strong>${pickedBy.length}</strong></div>
          <div><span>Status</span><strong>${teamStatus(team, view.officialTeamScores)}</strong></div>
          <div><span>W-D-L</span><strong>${record.w}-${record.d}-${record.l}</strong></div>
          <div><span>Value</span><strong>${escapeHtml(teamValueLabel(team, view.officialTeamScores, view.pickMap))}</strong></div>
        </div>
        <section class="drawer-group">
          <h4>Picked By</h4>
          <div class="picked-row">
            ${pickedBy.length ? pickedBy.map((player) => `<button class="chip picked-player-chip" type="button" data-player-link="${escapeHtml(player.slug)}">${escapeHtml(player.name)}</button>`).join("") : `<span class="small-muted">Unpicked</span>`}
          </div>
        </section>
        <section class="drawer-group">
          <h4>Results</h4>
          <ul class="rule-list">${resultsMarkup}</ul>
        </section>
        ${scheduleMarkup ? `<section class="drawer-group"><h4>Today</h4><ul class="rule-list">${scheduleMarkup}</ul></section>` : ""}
        <button class="drawer-action" type="button" data-open-team-tab="${escapeHtml(team.name)}">Open team card</button>
      `
    );
  }

  function wireDeepLinks(renderTeamView) {
    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-drawer-close]")) {
        closeDrawer();
        return;
      }

      const openPlayerTab = event.target.closest("[data-open-player-tab]");
      if (openPlayerTab) {
        const slug = openPlayerTab.dataset.openPlayerTab;
        closeDrawer();
        state.focusedPlayerSlug = slug;
        state.focusedTeamName = "";
        showPanel("picks");
        document.querySelectorAll(".player-card").forEach((card) => {
          card.classList.toggle("is-focused", card.dataset.playerSlug === state.focusedPlayerSlug);
        });
        scrollToElement(`#player-${CSS.escape(slug)}`);
        return;
      }

      const openTeamTab = event.target.closest("[data-open-team-tab]");
      if (openTeamTab) {
        const teamName = openTeamTab.dataset.openTeamTab;
        closeDrawer();
        state.focusedTeamName = teamName;
        state.teamView = "group";
        state.teamFilter = "all";
        state.search = "";
        syncTeamFilterControls();
        renderTeamView();
        showPanel("picks");
        scrollToElement(`#team-${CSS.escape(slugify(teamName))}`);
        return;
      }

      const playerButton = event.target.closest("[data-player-link]:not([data-team-link])");
      if (playerButton) {
        renderPlayerDrawer(playerButton.dataset.playerLink);
        return;
      }

      const pickButton = event.target.closest("[data-team-link]");
      if (pickButton) {
        renderTeamDrawer(pickButton.dataset.teamLink);
        return;
      }

      const row = event.target.closest("[data-player-row]");
      if (row && !event.target.closest("button")) {
        renderPlayerDrawer(row.dataset.playerRow);
        return;
      }

      const playerCard = event.target.closest(".player-card[data-player-slug]");
      if (playerCard && !event.target.closest("button")) {
        renderPlayerDrawer(playerCard.dataset.playerSlug);
        return;
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeDrawer();
        return;
      }

      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target.closest?.("[data-player-row]");
      if (row) {
        event.preventDefault();
        renderPlayerDrawer(row.dataset.playerRow);
      }
    });
  }

  function stageFromEspnEvent(event) {
    const slug = event.season?.slug || "";
    if (SKIPPED_STAGE_SLUGS.has(slug)) return null;
    return STAGE_BY_SLUG[slug] || "Groups";
  }

  function scheduleGameFromEspnEvent(event) {
    const stage = stageFromEspnEvent(event);
    if (!stage) return null;

    const competitors = event.competitions?.[0]?.competitors || [];
    if (competitors.length !== 2) return null;

    return {
      id: event.id,
      stage,
      kickoff: event.date,
      status: {
        state: event.status?.type?.state || "pre",
        completed: event.status?.type?.completed === true,
        description: event.status?.type?.description || "",
        detail: event.status?.type?.detail || "",
        shortDetail: event.status?.type?.shortDetail || "",
        displayClock: event.status?.displayClock || ""
      },
      competitors: competitors.map((competitor) => ({
        team: canonicalTeamName(competitor.team?.displayName),
        abbreviation: competitor.team?.abbreviation || "",
        score: Number(competitor.score || 0),
        winner: competitor.winner === true,
        homeAway: competitor.homeAway || ""
      }))
    };
  }

  async function refreshLiveScoreboard(render) {
    if (!window.fetch || !["http:", "https:"].includes(window.location.protocol)) return;

    const dateKey = dateKeyInEt();
    try {
      const response = await fetch(`${SCOREBOARD_URL}?dates=${dateKey}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`ESPN scoreboard returned ${response.status}`);
      const data = await response.json();
      const games = (data.events || [])
        .map(scheduleGameFromEspnEvent)
        .filter(Boolean)
        .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));

      state.schedule = games;
      state.scheduleMeta = {
        dateKey,
        dateLabel: dateLabelFromKey(dateKey),
        lastUpdated: `${timestampEt()} from ESPN.`,
        source: "ESPN FIFA World Cup scoreboard"
      };

      const projected = projectedResultsFromSchedule(games);
      state.liveProjection = projected.length > 0;
      state.liveStatus = `${timestampEt()} from ESPN.`;
      render();
    } catch (error) {
      console.warn("Live scoreboard refresh failed", error);
    }
  }

  function scheduleLiveScoreboard(render) {
    if (!["http:", "https:"].includes(window.location.protocol)) return;
    refreshLiveScoreboard(render);
    window.setInterval(() => refreshLiveScoreboard(render), LIVE_REFRESH_MS);
  }

  function scheduleHourlyRefresh() {
    if (!["http:", "https:"].includes(window.location.protocol)) return;
    window.setInterval(() => {
      window.location.reload();
    }, 60 * 60 * 1000);
  }

  function init() {
    const buildView = () => {
      const projectedResults = projectedResultsFromSchedule(state.schedule);
      state.liveProjection = projectedResults.length > 0;
      if (!state.liveStatus && state.scheduleMeta.lastUpdated) {
        state.liveStatus = state.scheduleMeta.lastUpdated;
      }

      const officialTeamScores = computeTeamScores(results);
      const liveTeamScores = computeTeamScores([...results, ...projectedResults]);
      const officialPlayers = enrichPlayers(officialTeamScores);
      const livePlayers = enrichPlayers(liveTeamScores);
      const pickMap = buildPickMap(officialPlayers);
      const warnings = validateData(officialPlayers, results);
      return { officialPlayers, livePlayers, pickMap, officialTeamScores, warnings };
    };

    const renderAll = () => {
      const view = buildView();
      state.currentView = view;
      document.getElementById("command-center").innerHTML = "";
      document.getElementById("insight-grid").innerHTML = "";
      renderTodayHeadline(view.officialPlayers);
      renderLeaderboard(view.officialPlayers, view.livePlayers, view.officialTeamScores);
      renderDailySchedule(view.pickMap);
      renderSummary(view.officialPlayers, view.pickMap);
      renderPlayers(view.officialPlayers, view.officialTeamScores, view.pickMap);
      renderTeams(view.officialPlayers, view.officialTeamScores, view.pickMap);
      renderRules(view.warnings);
    };

    const renderTeamView = () => {
      const view = buildView();
      state.currentView = view;
      renderTeams(view.officialPlayers, view.officialTeamScores, view.pickMap);
    };

    renderAll();
    syncPlayerControls();
    syncTeamFilterControls();
    wireTabs();
    wirePlayerControls(renderAll);
    wireTeamControls(renderTeamView);
    wireLeaderboardControls(renderAll);
    wireDeepLinks(renderTeamView);
    scheduleLiveScoreboard(renderAll);
    scheduleHourlyRefresh();
  }

  init();
})();
