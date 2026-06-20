/**
 * DB port for CW15. The real Supabase client (fresh `dcs-sports` project,
 * owned by CW9) is injected at deploy. In-session it is DARK, so we run against
 * an in-memory mock that honors the S1 frozen table shapes. No lane bypasses
 * RLS — reads of athlete-owned rows go through CW10's RLS-filtered surface; here
 * we only touch CW15-owned tables + read match_performances by athlete_id.
 */

export interface VisionJob {
  id: string;
  match_id: string | null;
  video_url: string;
  status: "queued" | "processing" | "done" | "failed" | "model_unavailable";
  version: string; // V1 | V2 | V3 | V4 (match-vision) | "drill" (aiScout)
  created_at: string;
  // aiScout drill fields (null for match-vision jobs)
  kind?: "match" | "drill";
  athlete_id?: string | null;
  drill?: string | null;
}

export interface VisionOutput {
  id: string;
  job_id: string;
  type: string; // highlight | event_tag | wagon_wheel | shot_map | heatmap
  data_json: unknown;
  confidence: number;
}

export interface TalentIndexRow {
  athlete_id: string;
  skill: number;
  potential: number;
  consistency: number;
  pressure: number;
  fitness: number;
  coach: number;
  composite: number;
  computed_at: string;
}

export interface FitnessTest {
  id: string;
  athlete_id: string;
  type: string; // sprint_30m | reaction | grip_strength | yo_yo ...
  value: number;
  date: string;
}

export interface MatchPerformance {
  id: string;
  match_id: string;
  athlete_id: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  overs: number;
  wickets: number;
  runs_conceded: number;
  catches: number;
  source: string;
}

/** Minimal athlete profile fields the Selection Intelligence selector filters on. */
export interface AthleteProfile {
  id: string;
  user_id: string;
  sport: string;
  role: string | null;          // e.g. "batter" | "bowler" | "all-rounder"
  bowling_style: string | null; // e.g. "off-spin" | "leg-spin" | "fast"
  batting_style: string | null;
  state: string | null;
  district: string | null;
  dob: string | null;           // for age-band filters (U19 etc.)
  visibility: string;           // RLS still applies; this is a post-RLS read
}

export interface DBPort {
  insertVisionJob(j: Omit<VisionJob, "id" | "created_at">): Promise<VisionJob>;
  getVisionJob(id: string): Promise<VisionJob | null>;
  updateVisionJobStatus(id: string, status: VisionJob["status"]): Promise<void>;
  insertVisionOutput(o: Omit<VisionOutput, "id">): Promise<VisionOutput>;
  getVisionOutputs(jobId: string): Promise<VisionOutput[]>;

  upsertTalentIndex(row: TalentIndexRow): Promise<TalentIndexRow>;
  getTalentIndex(athleteId: string): Promise<TalentIndexRow | null>;

  insertFitnessTest(t: Omit<FitnessTest, "id">): Promise<FitnessTest>;
  getFitnessTests(athleteId: string): Promise<FitnessTest[]>;

  // read-only — match_performances is CW12's factory output; CW15 aggregates it
  getMatchPerformances(athleteId: string): Promise<MatchPerformance[]>;
  /** Distinct athlete_ids that have at least one match performance (for batch recompute). */
  listAthleteIdsWithPerformances(): Promise<string[]>;
  /**
   * Discoverable athletes matching coarse filters, READ THROUGH RLS so minors /
   * private athletes never appear to a non-entitled caller. Used by the
   * Selection Intelligence selector. Caller token must be threaded.
   */
  findDiscoverableAthletes(filter: {
    sport?: string;
    role?: string;
    bowling_style?: string;
    state?: string;
    max_age?: number;
    min_age?: number;
    limit?: number;
  }): Promise<AthleteProfile[]>;
  /** True if the caller (bound token) has an admin role. Used to gate admin-only routes. */
  callerIsAdmin(): Promise<boolean>;
}

/** In-memory mock honoring S1 shapes. Swapped for Supabase at deploy. */
export class InMemoryDB implements DBPort {
  private jobs = new Map<string, VisionJob>();
  private outputs: VisionOutput[] = [];
  private talent = new Map<string, TalentIndexRow>();
  private fitness: FitnessTest[] = [];
  private perfs: MatchPerformance[] = [];
  private seq = 0;

  private id(p: string) {
    return `${p}_${++this.seq}_${Date.now().toString(36)}`;
  }

  async insertVisionJob(j: Omit<VisionJob, "id" | "created_at">) {
    const row: VisionJob = { ...j, id: this.id("vj"), created_at: new Date().toISOString() };
    this.jobs.set(row.id, row);
    return row;
  }
  async getVisionJob(id: string) {
    return this.jobs.get(id) ?? null;
  }
  async updateVisionJobStatus(id: string, status: VisionJob["status"]) {
    const j = this.jobs.get(id);
    if (j) j.status = status;
  }
  async insertVisionOutput(o: Omit<VisionOutput, "id">) {
    const row: VisionOutput = { ...o, id: this.id("vo") };
    this.outputs.push(row);
    return row;
  }
  async getVisionOutputs(jobId: string) {
    return this.outputs.filter((o) => o.job_id === jobId);
  }
  async upsertTalentIndex(row: TalentIndexRow) {
    this.talent.set(row.athlete_id, row);
    return row;
  }
  async getTalentIndex(athleteId: string) {
    return this.talent.get(athleteId) ?? null;
  }
  async insertFitnessTest(t: Omit<FitnessTest, "id">) {
    const row: FitnessTest = { ...t, id: this.id("ft") };
    this.fitness.push(row);
    return row;
  }
  async getFitnessTests(athleteId: string) {
    return this.fitness.filter((t) => t.athlete_id === athleteId);
  }
  async getMatchPerformances(athleteId: string) {
    return this.perfs.filter((p) => p.athlete_id === athleteId);
  }
  async listAthleteIdsWithPerformances() {
    return [...new Set(this.perfs.map((p) => p.athlete_id))];
  }
  private athletes: AthleteProfile[] = [];
  _seedAthletes(rows: AthleteProfile[]) {
    this.athletes.push(...rows);
  }
  async findDiscoverableAthletes(filter: {
    sport?: string; role?: string; bowling_style?: string; state?: string;
    max_age?: number; min_age?: number; limit?: number;
  }): Promise<AthleteProfile[]> {
    const now = Date.now();
    const ageOf = (dob: string | null) => (dob ? (now - new Date(dob).getTime()) / (365.25 * 24 * 3600 * 1000) : null);
    let rows = this.athletes.filter((a) => ["discoverable", "public"].includes(a.visibility));
    if (filter.sport) rows = rows.filter((a) => a.sport === filter.sport);
    if (filter.role) rows = rows.filter((a) => a.role === filter.role);
    if (filter.bowling_style) rows = rows.filter((a) => a.bowling_style === filter.bowling_style);
    if (filter.state) rows = rows.filter((a) => a.state === filter.state);
    if (filter.max_age != null) rows = rows.filter((a) => { const ag = ageOf(a.dob); return ag != null && ag <= filter.max_age!; });
    if (filter.min_age != null) rows = rows.filter((a) => { const ag = ageOf(a.dob); return ag != null && ag >= filter.min_age!; });
    return rows.slice(0, filter.limit ?? 100);
  }
  // Dev/test backend: admin status is set explicitly via _setAdmin (default true
  // so local dev isn't blocked). The live SupabaseDB enforces the real check.
  private admin = true;
  async callerIsAdmin() {
    return this.admin;
  }
  _setAdmin(v: boolean) {
    this.admin = v;
  }

  // test/seed helper — not part of the port
  _seedPerformances(rows: MatchPerformance[]) {
    this.perfs.push(...rows);
  }
}
