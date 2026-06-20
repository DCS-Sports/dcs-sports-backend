/**
 * aiScout DRILL ASSESSMENT SERVICE (v2.0 headline).
 *
 * record drill → job → queue → worker → athleticism/skill estimate + confidence.
 * Mirrors the vision pipeline. Honest-scope:
 *  - technique drills (batting/bowling): heuristic FORM-CUE checklist + a low-
 *    confidence enveloped skill estimate (model_version:null). Honest placeholder.
 *  - timed/measured drills (sprint/agility/jump): FAIL CLOSED without a trained
 *    model — we never fabricate a sprint time or athleticism number.
 *  - when a drill runner + model gate are present, the runner returns the real
 *    enveloped measure and the service persists it.
 *
 * Auto-highlights: markerless tracking → stitched clips. Heuristic placeholder
 * until the tracking model lands; never claims real event detection.
 */
import type { DBPort, VisionJob } from "../db/port";
import { makeEstimate, modelGate, ModelUnavailableError } from "../lib/estimate";
import type { Queue } from "../lib/queue";
import {
  DRILL_ATTRIBUTE,
  DRILL_MODEL_REQUIRED,
  DRILL_OUTPUT_TYPE,
  AUTO_HIGHLIGHT_OUTPUT_TYPE,
  type DrillType,
  type DrillAssessmentResult,
} from "./drill-contracts";

/** Optional real-model runner for drills (injected at deploy). */
export type DrillModelRunner = (input: {
  drill: DrillType;
  videoUrl: string;
  athleteId: string;
  endpoint: string;
}) => Promise<{ score: number; confidence: number; raw_measure?: number; model_version: string }>;

export class DrillService {
  constructor(
    private db: DBPort,
    private queue: Queue,
    private modelRunner?: DrillModelRunner,
  ) {}

  /** Submit a phone-drill assessment. Fails closed at submit for model-required drills when DARK. */
  async createJob(input: {
    athlete_id: string;
    drill: DrillType;
    video_url: string;
  }): Promise<VisionJob> {
    if (!input.video_url || !/^https?:\/\//.test(input.video_url)) {
      throw new Error("video_url must be an absolute http(s) URL (R2)");
    }
    const needsModel = DRILL_MODEL_REQUIRED[input.drill];
    if (needsModel && (!modelGate("cv_model").available || !this.modelRunner)) {
      // Persist as model_unavailable so the UI renders an honest state.
      return this.db.insertVisionJob({
        video_url: input.video_url,
        match_id: null,
        status: "model_unavailable",
        version: "drill",
        kind: "drill",
        athlete_id: input.athlete_id,
        drill: input.drill,
      });
    }
    const job = await this.db.insertVisionJob({
      video_url: input.video_url,
      match_id: null,
      status: "queued",
      version: "drill",
      kind: "drill",
      athlete_id: input.athlete_id,
      drill: input.drill,
    });
    await this.queue.enqueue("drill", { jobId: job.id });
    return job;
  }

  async getJob(id: string) {
    const job = await this.db.getVisionJob(id);
    if (!job) return null;
    const outputs = await this.db.getVisionOutputs(id);
    return { job, outputs };
  }

  /** Worker entry: process a drill job. */
  async process(jobId: string): Promise<void> {
    const job = await this.db.getVisionJob(jobId);
    if (!job || job.kind !== "drill") return;
    const drill = job.drill as DrillType;
    const athleteId = job.athlete_id as string;

    if (DRILL_MODEL_REQUIRED[drill] && (!modelGate("cv_model").available || !this.modelRunner)) {
      await this.db.updateVisionJobStatus(jobId, "model_unavailable");
      throw new ModelUnavailableError(`Drill ${drill}`, "cv_model");
    }

    await this.db.updateVisionJobStatus(jobId, "processing");
    try {
      const result = DRILL_MODEL_REQUIRED[drill]
        ? await this.modelBacked(athleteId, drill, job.video_url)
        : this.heuristicTechnique(athleteId, drill);

      await this.db.insertVisionOutput({
        job_id: jobId,
        type: DRILL_OUTPUT_TYPE,
        data_json: result,
        confidence: result.score.confidence,
      });

      // Auto-highlight a short clip of the drill (heuristic placeholder).
      await this.db.insertVisionOutput({
        job_id: jobId,
        type: AUTO_HIGHLIGHT_OUTPUT_TYPE,
        data_json: {
          type: "auto_highlight",
          clips: [{ start_s: 0, end_s: 6, label: `${drill} attempt`, confidence: 0.2 }],
          method: "heuristic_placeholder",
        },
        confidence: 0.2,
      });
      await this.db.updateVisionJobStatus(jobId, "done");
    } catch (e) {
      await this.db.updateVisionJobStatus(jobId, "failed");
      throw e;
    }
  }

  /** Model-backed measured drill (sprint/agility/jump). Only reached when gate+runner present. */
  private async modelBacked(athleteId: string, drill: DrillType, videoUrl: string): Promise<DrillAssessmentResult> {
    const gate = modelGate("cv_model");
    if (!gate.available || !this.modelRunner) throw new ModelUnavailableError(`Drill ${drill}`, "cv_model");
    const r = await this.modelRunner({ drill, videoUrl, athleteId, endpoint: gate.endpoint! });
    return {
      athlete_id: athleteId,
      drill,
      attribute: DRILL_ATTRIBUTE[drill],
      score: makeEstimate({ value: r.score, confidence: r.confidence, source: "talent", model_version: r.model_version }),
      raw_measure:
        r.raw_measure != null
          ? makeEstimate({ value: r.raw_measure, confidence: r.confidence, source: "talent", model_version: r.model_version })
          : undefined,
      contributed_to_talent: false,
    };
  }

  /** Heuristic technique assessment — honest form-cue checklist, low confidence, model_version:null. */
  private heuristicTechnique(athleteId: string, drill: DrillType): DrillAssessmentResult {
    const cues =
      drill === "batting_technique"
        ? ["head still at contact", "high front elbow", "balanced base", "full follow-through"]
        : ["smooth run-up rhythm", "side-on alignment", "high bowling arm", "controlled follow-through"];
    return {
      athlete_id: athleteId,
      drill,
      attribute: "technique",
      // Neutral placeholder score; confidence intentionally low — heuristic, not measured.
      score: makeEstimate({ value: 50, confidence: 0.2, source: "talent", model_version: null }),
      form_cues: cues,
      contributed_to_talent: false,
    };
  }
}
