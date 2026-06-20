/**
 * Supabase adapter for CW15 (live `dcs-sports` project, schema enforcing).
 *
 * Two clients per the wire-note:
 *  - serviceClient: SUPABASE_SERVICE_ROLE_KEY — bypasses RLS, for CW15-owned
 *    writes (vision_jobs/outputs, talent_index, fitness_tests).
 *  - rlsClient(token): SUPABASE_ANON_KEY + caller JWT — reads that touch
 *    athlete-owned rows go THROUGH RLS. We never hand-filter; the DB gates
 *    visibility + parent consent + grants + minor non-discoverability.
 *
 * match_performances is athlete-owned -> read via the RLS client so a scout
 * caller can never leak a private/minor athlete's rows. If no caller token is
 * available (server-internal recompute), we use the service client explicitly
 * and the caller is responsible for not exposing the result cross-athlete.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  DBPort,
  VisionJob,
  VisionOutput,
  TalentIndexRow,
  FitnessTest,
  MatchPerformance,
  AthleteProfile,
} from "./port";

const T = {
  visionJobs: "sports_vision_jobs",
  visionOutputs: "sports_vision_outputs",
  talentIndex: "sports_talent_index",
  fitnessTests: "sports_fitness_tests",
  matchPerformances: "sports_match_performances",
} as const;

export interface SupabaseDeps {
  url: string;
  serviceRoleKey: string;
  anonKey: string;
  /** Optional caller JWT for RLS-scoped athlete reads. */
  callerToken?: string | null;
}

export class SupabaseDB implements DBPort {
  private service: SupabaseClient;
  private anonKey: string;
  private url: string;
  private callerToken: string | null;

  constructor(deps: SupabaseDeps) {
    this.url = deps.url;
    this.anonKey = deps.anonKey;
    this.callerToken = deps.callerToken ?? null;
    this.service = createClient(deps.url, deps.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /** RLS-scoped client bound to the caller's JWT (athlete-owned reads). */
  private rls(): SupabaseClient {
    return createClient(this.url, this.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: this.callerToken
        ? { headers: { Authorization: `Bearer ${this.callerToken}` } }
        : undefined,
    });
  }

  // ---- CW15-owned writes (service role) ----
  async insertVisionJob(j: Omit<VisionJob, "id" | "created_at">): Promise<VisionJob> {
    const { data, error } = await this.service.from(T.visionJobs).insert(j).select().single();
    if (error) throw error;
    return data as VisionJob;
  }
  async getVisionJob(id: string): Promise<VisionJob | null> {
    const { data, error } = await this.service.from(T.visionJobs).select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as VisionJob) ?? null;
  }
  async updateVisionJobStatus(id: string, status: VisionJob["status"]): Promise<void> {
    const { error } = await this.service.from(T.visionJobs).update({ status }).eq("id", id);
    if (error) throw error;
  }
  async insertVisionOutput(o: Omit<VisionOutput, "id">): Promise<VisionOutput> {
    const { data, error } = await this.service.from(T.visionOutputs).insert(o).select().single();
    if (error) throw error;
    return data as VisionOutput;
  }
  async getVisionOutputs(jobId: string): Promise<VisionOutput[]> {
    const { data, error } = await this.service.from(T.visionOutputs).select("*").eq("job_id", jobId);
    if (error) throw error;
    return (data as VisionOutput[]) ?? [];
  }

  async upsertTalentIndex(row: TalentIndexRow): Promise<TalentIndexRow> {
    const { data, error } = await this.service
      .from(T.talentIndex)
      .upsert(row, { onConflict: "athlete_id" })
      .select()
      .single();
    if (error) throw error;
    return data as TalentIndexRow;
  }
  async getTalentIndex(athleteId: string): Promise<TalentIndexRow | null> {
    const { data, error } = await this.service
      .from(T.talentIndex)
      .select("*")
      .eq("athlete_id", athleteId)
      .maybeSingle();
    if (error) throw error;
    return (data as TalentIndexRow) ?? null;
  }

  async insertFitnessTest(t: Omit<FitnessTest, "id">): Promise<FitnessTest> {
    const { data, error } = await this.service.from(T.fitnessTests).insert(t).select().single();
    if (error) throw error;
    return data as FitnessTest;
  }
  async getFitnessTests(athleteId: string): Promise<FitnessTest[]> {
    const { data, error } = await this.service.from(T.fitnessTests).select("*").eq("athlete_id", athleteId);
    if (error) throw error;
    return (data as FitnessTest[]) ?? [];
  }

  // ---- athlete-owned read THROUGH RLS (never leak minor/private rows) ----
  async getMatchPerformances(athleteId: string): Promise<MatchPerformance[]> {
    const client = this.callerToken ? this.rls() : this.service;
    const { data, error } = await client.from(T.matchPerformances).select("*").eq("athlete_id", athleteId);
    if (error) throw error;
    return (data as MatchPerformance[]) ?? [];
  }

  /**
   * Distinct athlete_ids with performances — used by the batch recompute (server
   * job). Uses the service client since recompute runs server-side over all
   * athletes; the per-athlete writes it produces are CW15-owned (talent_index).
   */
  async listAthleteIdsWithPerformances(): Promise<string[]> {
    const { data, error } = await this.service.from(T.matchPerformances).select("athlete_id");
    if (error) throw error;
    const ids = (data as Array<{ athlete_id: string }>).map((r) => r.athlete_id);
    return [...new Set(ids)];
  }

  /**
   * Discoverable athletes through RLS — the selector is association-facing and
   * MUST NOT leak minors/private athletes. We use the RLS (caller-JWT) client so
   * the DB's visibility + minor-gating policies filter the rows; we additionally
   * filter by `visibility in (discoverable, public)` as defense-in-depth.
   */
  async findDiscoverableAthletes(filter: {
    sport?: string; role?: string; bowling_style?: string; state?: string;
    max_age?: number; min_age?: number; limit?: number;
  }): Promise<AthleteProfile[]> {
    const client = this.callerToken ? this.rls() : this.service;
    let q = client
      .from("sports_athletes")
      .select("id,user_id,sport,role,bowling_style,batting_style,state,district,dob,visibility")
      .in("visibility", ["discoverable", "public"]);
    if (filter.sport) q = q.eq("sport", filter.sport);
    if (filter.role) q = q.eq("role", filter.role);
    if (filter.bowling_style) q = q.eq("bowling_style", filter.bowling_style);
    if (filter.state) q = q.eq("state", filter.state);
    // Age filters via dob bounds (max_age => born after; min_age => born before).
    const now = Date.now();
    if (filter.max_age != null) {
      const after = new Date(now - filter.max_age * 365.25 * 24 * 3600 * 1000).toISOString();
      q = q.gte("dob", after);
    }
    if (filter.min_age != null) {
      const before = new Date(now - filter.min_age * 365.25 * 24 * 3600 * 1000).toISOString();
      q = q.lte("dob", before);
    }
    q = q.limit(filter.limit ?? 100);
    const { data, error } = await q;
    if (error) throw error;
    return (data as AthleteProfile[]) ?? [];
  }

  /**
   * True if the caller's token maps to a user with the `admin` role flag.
   * Resolves the user from the JWT (RLS client), then reads their role_flags from
   * sports_users via the service client. No token -> not admin (fail-closed).
   */
  async callerIsAdmin(): Promise<boolean> {
    if (!this.callerToken) return false;
    const { data: userData, error: userErr } = await this.rls().auth.getUser();
    if (userErr || !userData?.user?.id) return false;
    const { data, error } = await this.service
      .from("sports_users")
      .select("role_flags")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (error || !data) return false;
    const flags = (data as { role_flags?: string[] }).role_flags ?? [];
    return flags.includes("admin");
  }
}

export function supabaseConfigFromEnv(callerToken?: string | null): SupabaseDeps | null {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !serviceRoleKey || !anonKey) return null;
  return { url, serviceRoleKey, anonKey, callerToken: callerToken ?? null };
}
