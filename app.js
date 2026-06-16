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
    schedule: initialSchedule,
    scheduleMeta: initialScheduleMeta,
    liveProjection: false,
    liveStatus: ""
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
      return `<img class="inline-flag flag-img" src="${escapeHtml(item.flagImage)}" alt="" loading="lazy">`;
    }
    return `<span class="inline-flag" aria-hidden="true">${escapeHtml(item.flag)}</span>`;
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
      const bestTeam = knownPicks.reduce((best, team) => (!best || team.price > best.price ? team : best), null);

      return {
        ...player,
        knownPicks,
        unknownPicks,
        budgetUsed,
        tier1Count,
        tier3Count,
        points,
        aliveCount,
        bestTeam
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
    const activePlayers = enrichedPlayers.filter((player) => !player.pending && player.knownPicks.length);
    const pickedTeams = [...pickMap.values()].filter((pickedBy) => pickedBy.length > 0).length;
    const totalBudget = activePlayers.reduce((sum, player) => sum + player.budgetUsed, 0);
    const topTeam = [...pickMap.entries()]
      .map(([teamName, pickedBy]) => ({ team: resolveTeam(teamName), count: pickedBy.length }))
      .sort((a, b) => b.count - a.count || b.team.price - a.team.price)[0];

    const cards = [
      { label: "Players", value: players.length },
      { label: "Picked Teams", value: `${pickedTeams}/${teams.length}` },
      { label: "Budget Spent", value: money(totalBudget) },
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

  function scheduleStatus(game) {
    if (game.status?.completed) return "Final";
    if (game.status?.state === "in") {
      return game.status.shortDetail || game.status.displayClock || "Live";
    }
    return formatKickoff(game.kickoff);
  }

  function scheduleTeamMarkup(competitor, pickMap, showScore) {
    const team = resolveTeam(competitor.team);
    const pickedBy = team ? pickMap.get(team.name) || [] : [];
    const item = team || { name: competitor.team, flag: "" };
    const pickedText = pickedBy.length ? `${pickedBy.length} ${pickedBy.length === 1 ? "pick" : "picks"}` : "unpicked";
    const tag = team ? "button" : "div";
    const attrs = team
      ? `type="button" data-team-link="${escapeHtml(team.name)}" aria-label="View ${escapeHtml(team.name)} team card"`
      : "";
    return `
      <${tag} class="score-team${team ? " score-team-button" : ""}${competitor.winner ? " is-winner" : ""}" ${attrs}>
        <div>
          <strong>${team ? flagMarkup(item) : ""} ${escapeHtml(competitor.team)}</strong>
          <span>${escapeHtml(pickedText)}</span>
        </div>
        <b>${showScore ? escapeHtml(competitor.score) : "-"}</b>
      </${tag}>
    `;
  }

  function renderDailySchedule(pickMap) {
    const scheduleEl = document.getElementById("daily-scoreboard");
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
                ${game.competitors.map((competitor) => scheduleTeamMarkup(competitor, pickMap, showScore)).join("")}
              </div>
            </article>
          `;
        }).join("")
      : `<div class="empty-state">No games listed for today.</div>`;

    scheduleEl.innerHTML = `
      <article class="scoreboard-panel">
        <div class="scoreboard-head">
          <div>
            <p class="eyebrow">Matchday</p>
            <h3>Today's Games</h3>
          </div>
          <div>
            <strong>${escapeHtml(state.scheduleMeta.dateLabel || "Today")}</strong>
            <span>${escapeHtml(state.scheduleMeta.lastUpdated || resultsMeta.lastUpdated || "")}</span>
          </div>
        </div>
        <div class="scoreboard-grid">${gamesMarkup}</div>
      </article>
    `;
  }

  function renderLeaderboard(officialPlayers, livePlayers) {
    const officialBySlug = new Map(officialPlayers.map((player) => [player.slug, player]));
    const isLiveMode = state.leaderboardMode === "live";
    const sourcePlayers = isLiveMode ? livePlayers : officialPlayers;
    const sorted = [...sourcePlayers].sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (a.pending !== b.pending) return a.pending ? 1 : -1;
      if (b.budgetUsed !== a.budgetUsed) return b.budgetUsed - a.budgetUsed;
      return a.name.localeCompare(b.name);
    });

    const rows = sorted.map((player, index) => {
      const officialPlayer = officialBySlug.get(player.slug);
      const delta = isLiveMode && officialPlayer ? player.points - officialPlayer.points : 0;
      const deltaMarkup = delta
        ? `<span class="point-delta ${delta > 0 ? "positive" : "negative"}">${delta > 0 ? "+" : ""}${delta} live</span>`
        : "";
      const best = player.bestTeam
        ? `${flagMarkup(player.bestTeam)} ${escapeHtml(player.bestTeam.name)} (${money(player.bestTeam.price)})`
        : "Pending";
      const status = player.pending ? "Picks pending" : plural(player.knownPicks.length, "team");
      return `
        <tr>
          <td><span class="rank-badge">${index + 1}</span></td>
          <td>
            <button class="leader-player leader-player-button" type="button" data-player-link="${escapeHtml(player.slug)}" aria-label="View ${escapeHtml(player.name)} player card">
              ${avatarMarkup(player, "mini")}
              <div>
                <strong>${escapeHtml(player.name)}</strong>
                <span>${escapeHtml(status)}</span>
              </div>
            </button>
          </td>
          <td><strong>${player.points}</strong>${deltaMarkup}</td>
          <td>${money(player.budgetUsed)}</td>
          <td>${player.aliveCount}</td>
          <td>${player.knownPicks.length}</td>
          <td>${best}</td>
        </tr>
      `;
    });

    const liveNote = state.liveProjection
      ? "Live Leaderboard treats active/latest scores as final for now."
      : "No active match projection right now; live matches will update here.";

    document.getElementById("leaderboard-table").innerHTML = `
      <div class="ranking-toolbar">
        <div class="segmented-control ranking-toggle" role="group" aria-label="Leaderboard mode">
          <button class="segment ${!isLiveMode ? "is-active" : ""}" type="button" data-leaderboard-mode="official" aria-pressed="${String(!isLiveMode)}">Leaderboard</button>
          <button class="segment ${isLiveMode ? "is-active" : ""}" type="button" data-leaderboard-mode="live" aria-pressed="${String(isLiveMode)}">Live Leaderboard</button>
        </div>
        <p>${escapeHtml(isLiveMode ? liveNote : "Official standings use completed match results only.")}</p>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Player</th>
              <th>Points</th>
              <th>Budget</th>
              <th>Alive</th>
              <th>Teams</th>
              <th>Best Team</th>
            </tr>
          </thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    `;

  }

  function avatarMarkup(player, size = "full") {
    if (!player.image) {
      return `<span class="${size === "mini" ? "mini-avatar" : "initials-avatar"}">${escapeHtml(initials(player.name))}</span>`;
    }

    const className = size === "mini" ? "mini-avatar" : "";
    return `<img class="${className}" src="${escapeHtml(player.image)}" alt="${escapeHtml(player.name)} headshot" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'), {className: '${size === "mini" ? "mini-avatar" : "initials-avatar"}', textContent: '${escapeHtml(initials(player.name))}'}));">`;
  }

  function renderPlayers(enrichedPlayers, teamScores) {
    document.getElementById("players-grid").innerHTML = [...enrichedPlayers]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map((player) => {
        const theme = getPlayerTheme(player);
        const focused = player.slug === state.focusedPlayerSlug ? " is-focused" : "";
        const nationalityChips = (player.nationalities || [])
          .map((nationality) => `<span class="chip">${flagMarkup(nationality)} ${escapeHtml(nationality.name)}</span>`)
          .join("");
        const picksMarkup = player.pending || player.knownPicks.length === 0
          ? `<span class="status-pill">Picks pending</span>`
          : player.knownPicks.map((team) => {
              const score = teamScores.get(team.name);
              const eliminated = score?.eliminated ? " is-eliminated" : "";
              return `
                <button class="team-pill pick-button${eliminated}" type="button" data-team-link="${escapeHtml(team.name)}" data-player-link="${escapeHtml(player.slug)}" aria-label="View ${escapeHtml(team.name)} team card picked by ${escapeHtml(player.name)}">
                  ${flagMarkup(team)} ${escapeHtml(team.name)}
                  <span class="price">${money(team.price)}</span>
                  <span class="pick-points">${score?.points || 0} pts</span>
                  <span>${escapeHtml(groupLabel(team.group))}</span>
                </button>
              `;
            }).join("");

        return `
          <article class="player-card${focused}" id="player-${escapeHtml(player.slug)}" data-player-slug="${escapeHtml(player.slug)}" style="--c1:${theme.c1};--c2:${theme.c2}">
            <div class="player-head">
              <div class="avatar-wrap">${avatarMarkup(player)}</div>
              <div class="player-title">
                <h3>${escapeHtml(player.name)}</h3>
                <div class="nationality-row">${nationalityChips}</div>
              </div>
            </div>
            <div class="player-metrics">
              <div class="metric"><span class="metric-label">Points</span><strong>${player.points}</strong></div>
              <div class="metric"><span class="metric-label">Budget</span><strong>${money(player.budgetUsed)}</strong></div>
              <div class="metric"><span class="metric-label">Teams</span><strong>${player.knownPicks.length}</strong></div>
              <div class="metric"><span class="metric-label">Alive</span><strong>${player.aliveCount}</strong></div>
            </div>
            <p class="picks-title">Picks</p>
            <div class="pill-row">${picksMarkup}</div>
          </article>
        `;
      })
      .join("");
  }

  function teamCardMarkup(team, teamScores, pickMap) {
    const pickedBy = pickMap.get(team.name) || [];
    const score = teamScores.get(team.name);
    const isFocused = normalize(team.name) === normalize(state.focusedTeamName);
    const pickedMarkup = pickedBy.length
      ? pickedBy.map((player) => {
          const selected = isFocused && player.slug === state.focusedPlayerSlug ? " is-selected" : "";
          return `<span class="chip picked-player-chip${selected}">${escapeHtml(player.name)}</span>`;
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
        <div class="team-stats">
          <div class="team-stat"><span>Picked</span><strong>${pickedBy.length}</strong></div>
          <div class="team-stat"><span>Points</span><strong>${score?.points || 0}</strong></div>
          <div class="team-stat"><span>Status</span><strong>${score?.eliminated ? "Out" : "Alive"}</strong></div>
        </div>
        <p class="picked-label">Picked by</p>
        <div class="picked-row">${pickedMarkup}</div>
      </article>
    `;
  }

  function renderTeams(enrichedPlayers, teamScores, pickMap) {
    const query = normalize(state.search);
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
    }).sort((a, b) => groupRank(a.group) - groupRank(b.group) || b.price - a.price || a.name.localeCompare(b.name));

    const grouped = filteredTeams.reduce((groups, team) => {
      const key = team.group || "TBD";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(team);
      return groups;
    }, new Map());

    document.getElementById("teams-grid").innerHTML = filteredTeams.length
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
      : `<div class="empty-state">No teams match this view.</div>`;
  }

  function renderRules(warnings) {
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

    const checksMarkup = warnings.length
      ? `<ul class="checks-list">${warnings.map((warning) => `<li class="check-item ${warning.level === "error" ? "error" : ""}">${escapeHtml(warning.text)}</li>`).join("")}</ul>`
      : `<p class="status-pill ok">No data issues detected.</p>`;

    document.getElementById("rules-content").innerHTML = `
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
    document.getElementById("team-search").value = state.search;
  }

  function wireTeamControls(render) {
    document.querySelectorAll("[data-team-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.teamFilter = button.dataset.teamFilter;
        syncTeamFilterControls();
        render();
      });
    });

    document.getElementById("team-search").addEventListener("input", (event) => {
      state.search = event.target.value;
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

  function wireDeepLinks(renderTeamView) {
    document.addEventListener("click", (event) => {
      const playerButton = event.target.closest("[data-player-link]:not([data-team-link])");
      if (playerButton) {
        state.focusedPlayerSlug = playerButton.dataset.playerLink;
        state.focusedTeamName = "";
        showPanel("players");
        document.querySelectorAll(".player-card").forEach((card) => {
          card.classList.toggle("is-focused", card.dataset.playerSlug === state.focusedPlayerSlug);
        });
        scrollToElement(`#player-${CSS.escape(state.focusedPlayerSlug)}`);
        return;
      }

      const pickButton = event.target.closest("[data-team-link]");
      if (!pickButton) return;

      state.focusedPlayerSlug = pickButton.dataset.playerLink || "";
      state.focusedTeamName = pickButton.dataset.teamLink;
      state.teamFilter = "all";
      state.search = "";
      syncTeamFilterControls();
      renderTeamView();
      showPanel("teams");
      scrollToElement(`#team-${CSS.escape(slugify(state.focusedTeamName))}`);
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
      renderDailySchedule(view.pickMap);
      renderLeaderboard(view.officialPlayers, view.livePlayers);
      renderSummary(view.officialPlayers, view.pickMap);
      renderPlayers(view.officialPlayers, view.officialTeamScores);
      renderTeams(view.officialPlayers, view.officialTeamScores, view.pickMap);
      renderRules(view.warnings);
    };

    const renderTeamView = () => {
      const view = buildView();
      renderTeams(view.officialPlayers, view.officialTeamScores, view.pickMap);
    };

    renderAll();
    wireTabs();
    wireTeamControls(renderTeamView);
    wireLeaderboardControls(renderAll);
    wireDeepLinks(renderTeamView);
    scheduleLiveScoreboard(renderAll);
    scheduleHourlyRefresh();
  }

  init();
})();
