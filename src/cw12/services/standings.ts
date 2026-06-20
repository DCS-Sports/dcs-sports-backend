// CW12 — standings + leaderboard recompute.
// Standings come from match results; leaderboard from aggregated performances.
// Net run rate is computed from per-match innings summaries (runs_for / overs_faced),
// using the all-out full-quota rule when max_overs is known. Matches without a
// summary contribute points but 0 to NRR (honest: no fabricated rate).

import type {
  Match, StandingRow, LeaderboardRow, MatchPerformance, SportConfig, MatchInningsSummary,
} from '../types/index';
import { getSportConfig } from './sportConfig';

interface NrrAcc { runs_for: number; overs_for: number; runs_against: number; overs_against: number; }

// normalize cricket "decimal" overs (19.4 = 19 overs + 4 balls) to true fractional overs
function realOvers(overs: number): number {
  const whole = Math.floor(overs);
  const balls = Math.round((overs - whole) * 10);
  return whole + balls / 6;
}

export function computeStandings(
  sport: string,
  teams: { id: string; name: string }[],
  matches: Match[],
  maxOvers?: number | null,
): StandingRow[] {
  const cfg: SportConfig = getSportConfig(sport);
  const rules = cfg.scoring_rules_json;
  const table: Record<string, StandingRow> = {};
  const nrr: Record<string, NrrAcc> = {};
  for (const t of teams) {
    table[t.id] = {
      team_id: t.id, team_name: t.name,
      played: 0, won: 0, lost: 0, tied: 0, no_result: 0,
      points: 0, net_run_rate: 0,
    };
    nrr[t.id] = { runs_for: 0, overs_for: 0, runs_against: 0, overs_against: 0 };
  }

  for (const m of matches) {
    if (m.status !== 'completed') continue;
    const home = table[m.home_team_id];
    const away = table[m.away_team_id];
    if (!home || !away) continue;
    home.played++; away.played++;

    if (m.result === 'tie') {
      home.tied++; away.tied++;
      home.points += rules.points_tie; away.points += rules.points_tie;
    } else if (m.result === 'no_result' || !m.result) {
      home.no_result++; away.no_result++;
      home.points += rules.points_no_result; away.points += rules.points_no_result;
    } else if (m.result === m.home_team_id) {
      home.won++; away.lost++;
      home.points += rules.points_win; away.points += rules.points_loss;
    } else if (m.result === m.away_team_id) {
      away.won++; home.lost++;
      away.points += rules.points_win; home.points += rules.points_loss;
    }

    // accumulate NRR from the persisted innings summary (only when present)
    const summary = m.innings_summary;
    if (summary && summary.length >= 2) {
      for (const s of summary) {
        const acc = nrr[s.team_id];
        if (!acc) continue;
        // all-out: use full quota of overs for NRR (cricket convention)
        const oversUsed = s.all_out && maxOvers ? maxOvers : realOvers(s.overs_faced);
        acc.runs_for += s.runs_for;
        acc.overs_for += oversUsed;
        // opponent runs count against this team
        for (const opp of summary) {
          if (opp.team_id === s.team_id) continue;
          const oppOvers = opp.all_out && maxOvers ? maxOvers : realOvers(opp.overs_faced);
          acc.runs_against += opp.runs_for;
          acc.overs_against += oppOvers;
        }
      }
    }
  }

  for (const id of Object.keys(table)) {
    const a = nrr[id];
    const rf = a.overs_for > 0 ? a.runs_for / a.overs_for : 0;
    const ra = a.overs_against > 0 ? a.runs_against / a.overs_against : 0;
    table[id].net_run_rate = +(rf - ra).toFixed(3);
  }

  return Object.values(table).sort(
    (a, b) => b.points - a.points || b.net_run_rate - a.net_run_rate,
  );
}

export function computeLeaderboard(
  sport: string,
  performances: MatchPerformance[],
): LeaderboardRow[] {
  const cfg = getSportConfig(sport);
  const byAthlete: Record<string, LeaderboardRow> = {};
  for (const p of performances) {
    const row = (byAthlete[p.athlete_id] ??= {
      athlete_id: p.athlete_id, runs: 0, wickets: 0, matches: 0, catches: 0,
      batting_strike_rate: 0,
    });
    row.runs += p.runs;
    row.wickets += p.wickets;
    row.catches += p.catches;
    row.matches += 1;
  }
  // strike rate over the aggregate (needs balls; recompute from perf list)
  const ballsByAthlete: Record<string, number> = {};
  for (const p of performances) ballsByAthlete[p.athlete_id] = (ballsByAthlete[p.athlete_id] ?? 0) + p.balls;
  for (const id of Object.keys(byAthlete)) {
    const balls = ballsByAthlete[id] ?? 0;
    byAthlete[id].batting_strike_rate = balls > 0
      ? +((byAthlete[id].runs / balls) * 100).toFixed(2)
      : 0;
  }

  const sortKey = cfg.stat_fields_json.leaderboard_sort;
  return Object.values(byAthlete).sort((a, b) => {
    if (sortKey === 'wickets') return b.wickets - a.wickets || b.runs - a.runs;
    return b.runs - a.runs || b.wickets - a.wickets;
  });
}
