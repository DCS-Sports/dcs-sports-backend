// CW12 — sport-agnostic config registry.
// Frozen ruling #6: structure sport-agnostic from Day-0. cricket = config #1.
// Football (#2) and Kabaddi (#3) prove the engine generalizes: a new sport is a config
// row + (for non-cricket) a generic event map — NO change to fixtures, standings, or routes.

import type { SportConfig } from '../types/index';

// --- #1 CRICKET — ball-by-ball engine (innings/over/ball) ---
export const CRICKET: SportConfig = {
  sport: 'cricket',
  scoring_model: 'ball_by_ball',
  stat_fields_json: {
    perf_fields: ['runs', 'balls', 'fours', 'sixes', 'overs', 'wickets', 'runs_conceded', 'catches'],
    leaderboard_sort: 'runs',
  },
  scoring_rules_json: {
    legal_balls_per_over: 6,
    extras_are_legal: { wide: false, no_ball: false },
    points_win: 2,
    points_tie: 1,
    points_loss: 0,
    points_no_result: 1,
  },
};

// --- #2 FOOTBALL — generic period-points engine (2 halves) ---
export const FOOTBALL: SportConfig = {
  sport: 'football',
  scoring_model: 'period_points',
  stat_fields_json: {
    perf_fields: ['goals', 'assists', 'yellow_cards', 'red_cards', 'saves'],
    leaderboard_sort: 'points',
  },
  scoring_rules_json: {
    periods: 2,
    events: {
      goal: { stat: 'goals', points: 1, assist_stat: 'assists' },
      own_goal: { stat: 'own_goals', points: 0 }, // scored to the other team by caller
      yellow_card: { stat: 'yellow_cards', points: 0 },
      red_card: { stat: 'red_cards', points: 0 },
      save: { stat: 'saves', points: 0 },
    },
    points_win: 3,   // football league points
    points_tie: 1,
    points_loss: 0,
    points_no_result: 1,
  },
};

// --- #3 KABADDI — generic period-points engine (2 halves, raid/tackle points) ---
export const KABADDI: SportConfig = {
  sport: 'kabaddi',
  scoring_model: 'period_points',
  stat_fields_json: {
    perf_fields: ['raid_points', 'tackle_points', 'bonus_points', 'super_raids', 'super_tackles'],
    leaderboard_sort: 'points',
  },
  scoring_rules_json: {
    periods: 2,
    events: {
      raid_point: { stat: 'raid_points', points: 1 },
      bonus_point: { stat: 'bonus_points', points: 1 },
      tackle_point: { stat: 'tackle_points', points: 1 },
      super_raid: { stat: 'super_raids', points: 3 },
      super_tackle: { stat: 'super_tackles', points: 2 },
      all_out: { stat: 'all_outs', points: 2 },
    },
    points_win: 5,   // kabaddi league points (win=5, tie=3, loss-with-bonus etc. simplified)
    points_tie: 3,
    points_loss: 0,
    points_no_result: 1,
  },
};

const REGISTRY: Record<string, SportConfig> = {
  cricket: CRICKET,
  football: FOOTBALL,
  kabaddi: KABADDI,
};

export function getSportConfig(sport: string): SportConfig {
  const cfg = REGISTRY[sport];
  if (!cfg) {
    // fail-closed: never silently score with wrong rules
    throw new Error(`No sport_config for "${sport}". Add a sports_sport_config row first.`);
  }
  return cfg;
}

export function registerSportConfig(cfg: SportConfig): void {
  REGISTRY[cfg.sport] = cfg;
}

export function listSports(): string[] {
  return Object.keys(REGISTRY);
}

export function scoringModelFor(sport: string): SportConfig['scoring_model'] {
  return getSportConfig(sport).scoring_model;
}
