// CW14 · OPPORTUNITIES (S2: 4.8b scholarships, 4.15 sponsor connect). Supabase-wired. Money DARK.
//  GET /scholarships?sport=&age=    POST /sponsor/match

import { Router, Request, Response } from 'express';
import { listScholarships } from '../lib/data';
import { estimate } from '../lib/honest_scope';
import type { SponsorMatch } from '../lib/contracts';

const router = Router();

router.get('/scholarships', async (req: Request, res: Response) => {
  try {
    const { sport, age } = req.query as Record<string, string>;
    const rows = await listScholarships({ sport, age: age ? Number(age) : undefined });
    res.json({ count: rows.length, scholarships: rows });
  } catch (e: any) {
    res.status(500).json({ error: 'scholarships_failed', detail: String(e?.message ?? e) });
  }
});

router.post('/sponsor/match', (req: Request, res: Response) => {
  const { sponsor_id, athlete_id } = req.body ?? {};
  const match: SponsorMatch = {
    sponsor_id: sponsor_id ?? 'spon_001',
    athlete_id: athlete_id ?? 'ath_001',
    match_score: estimate<number>(0, 0.0, 'scout_ai', null), // DARK: needs model + adoption data
  };
  res.json({ match, note: 'Sponsor matching scaffolded; scoring DARK until model + data land. No money moves.' });
});

export default router;
