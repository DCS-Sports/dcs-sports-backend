// src/routes/fixtures.ts
// Pure fixture generators (CW12). Round-robin (circle method) + single-elim
// knockout. No DB — tested directly; the route persists the output.
export interface Fixture {
  round: number;
  home_team_id: string;
  away_team_id: string;
}

/** Round-robin via the circle method. Odd team counts get a BYE sentinel. */
export function roundRobin(teamIds: string[]): Fixture[] {
  const teams = [...teamIds];
  if (teams.length < 2) return [];
  if (teams.length % 2 === 1) teams.push('BYE');
  const n = teams.length;
  const rounds = n - 1;
  const half = n / 2;
  const fixtures: Fixture[] = [];
  let arr = [...teams];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < half; i++) {
      const home = arr[i];
      const away = arr[n - 1 - i];
      if (home !== 'BYE' && away !== 'BYE') {
        fixtures.push({ round: r + 1, home_team_id: home, away_team_id: away });
      }
    }
    // rotate all but the first
    arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];
  }
  return fixtures;
}

/** Single-elimination first round pairings. Odd team gets a round-1 bye. */
export function knockout(teamIds: string[]): Fixture[] {
  const teams = [...teamIds];
  const fixtures: Fixture[] = [];
  for (let i = 0; i + 1 < teams.length; i += 2) {
    fixtures.push({ round: 1, home_team_id: teams[i], away_team_id: teams[i + 1] });
  }
  return fixtures;
}

export function generateFixtures(format: string, teamIds: string[]): Fixture[] {
  switch (format) {
    case 'round_robin':
      return roundRobin(teamIds);
    case 'knockout':
      return knockout(teamIds);
    case 'hybrid':
      // group stage (round-robin) — knockout seeded later from standings
      return roundRobin(teamIds);
    default:
      throw new Error(`[fixtures] unknown format '${format}'`);
  }
}
