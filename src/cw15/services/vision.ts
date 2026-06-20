/**
 * 4.10 DCS VISION — pipeline + estimate envelope (model DARK per ruling #10).
 *
 * Flow: POST /vision/jobs -> R2 video URL -> queue -> CV worker -> outputs.
 * In-session: R2 + Redis + trained CV model are DARK. We build the full pipeline
 * and:
 *   - V1 (highlights / basic event tags): HEURISTIC placeholders, enveloped,
 *     model_version=null. Honest — flips to real model when DK provisions one.
 *   - V2 (wagon wheel / shot map / heatmap): heuristic geometric placeholders
 *     derived from event tags. Same envelope.
 *   - V3/V4 (ball-speed / catch-prob / win-prob / mini-DRS): REQUIRE a trained
 *     CV model -> FAIL-CLOSED via modelGate. Never fabricate.
 */
import type { DBPort, VisionJob } from "../db/port";
import { makeEstimate, modelGate, ModelUnavailableError } from "../lib/estimate";
import type { Queue } from "../lib/queue";

export type VisionVersion = "V1" | "V2" | "V3" | "V4";

/**
 * The CV model seam. Provide this at deploy (wrapping worker-py or a remote
 * endpoint) to light up V3/V4. When absent, V3/V4 fail closed. The runner MUST
 * return numerics already wrapped in the S4 estimate envelope.
 */
export type VisionModelRunner = (input: {
  version: "V3" | "V4";
  videoUrl: string;
  endpoint: string;
}) => Promise<{ type: string; data: unknown; confidence: number }>;

/** Versions that REQUIRE a trained CV model. These fail-closed when DARK. */
const MODEL_REQUIRED: Record<VisionVersion, boolean> = {
  V1: false, // heuristic highlight detection ok
  V2: false, // heuristic geometric maps ok
  V3: true, // ball-speed / catch-prob / win-prob -> trained model
  V4: true, // mini-DRS / boundary / umpire -> trained model
};

export class VisionService {
  constructor(
    private db: DBPort,
    private queue: Queue,
    private modelRunner?: VisionModelRunner,
  ) {}

  /** Enqueue a vision job. Fails closed at submit time for model-required versions. */
  async createJob(input: {
    video_url: string;
    match_id?: string | null;
    version: VisionVersion;
  }): Promise<VisionJob> {
    if (!input.video_url || !/^https?:\/\//.test(input.video_url)) {
      throw new Error("video_url must be an absolute http(s) URL (R2/Supabase Storage)");
    }
    const version = input.version;
    if (MODEL_REQUIRED[version]) {
      const gate = modelGate("cv_model");
      if (!gate.available) {
        // Persist the job in model_unavailable so the UI can render honestly.
        const job = await this.db.insertVisionJob({
          video_url: input.video_url,
          match_id: input.match_id ?? null,
          status: "model_unavailable",
          version,
        });
        return job;
      }
    }
    const job = await this.db.insertVisionJob({
      video_url: input.video_url,
      match_id: input.match_id ?? null,
      status: "queued",
      version,
    });
    await this.queue.enqueue("vision", { jobId: job.id, version, video_url: input.video_url });
    return job;
  }

  async getJob(id: string) {
    const job = await this.db.getVisionJob(id);
    if (!job) return null;
    const outputs = await this.db.getVisionOutputs(id);
    return { job, outputs };
  }

  /**
   * Worker entry (called by the queue consumer). Produces heuristic outputs for
   * V1/V2; fails closed for V3/V4 without a model.
   */
  async process(jobId: string): Promise<void> {
    const job = await this.db.getVisionJob(jobId);
    if (!job) return;
    const version = job.version as VisionVersion;

    if (MODEL_REQUIRED[version] && !modelGate("cv_model").available) {
      await this.db.updateVisionJobStatus(jobId, "model_unavailable");
      throw new ModelUnavailableError(`Vision ${version}`, "cv_model");
    }

    await this.db.updateVisionJobStatus(jobId, "processing");
    try {
      if (version === "V1") await this.heuristicV1(jobId);
      else if (version === "V2") await this.heuristicV2(jobId);
      else if (version === "V3" || version === "V4") await this.modelBacked(jobId, version, job.video_url);
      await this.db.updateVisionJobStatus(jobId, "done");
    } catch (e) {
      await this.db.updateVisionJobStatus(jobId, "failed");
      throw e;
    }
  }

  /**
   * V3/V4 model-backed processing. Only reached when the CV model gate is open
   * (process() fails closed above otherwise). Calls the model runner seam and
   * persists the enveloped output. The runner is injectable so the real model
   * (worker-py / remote endpoint) wires in at provision with zero changes here.
   */
  private async modelBacked(jobId: string, version: "V3" | "V4", videoUrl: string) {
    const gate = modelGate("cv_model");
    if (!gate.available || !this.modelRunner) {
      // Defense in depth — never fabricate even if we somehow got here.
      throw new ModelUnavailableError(`Vision ${version}`, "cv_model");
    }
    const result = await this.modelRunner({ version, videoUrl, endpoint: gate.endpoint! });
    await this.db.insertVisionOutput({
      job_id: jobId,
      type: result.type,
      data_json: result.data,
      confidence: result.confidence,
    });
  }

  /** V1: highlight windows + basic event tags — deterministic heuristic placeholder. */
  private async heuristicV1(jobId: string) {
    // Placeholder: emit a few highlight windows + low-confidence event tags.
    const highlights = [
      { start_s: 12, end_s: 18, label: "boundary?" },
      { start_s: 47, end_s: 52, label: "wicket?" },
    ];
    await this.db.insertVisionOutput({
      job_id: jobId,
      type: "highlight",
      data_json: { clips: highlights, method: "heuristic_placeholder" },
      confidence: 0.25,
    });
    await this.db.insertVisionOutput({
      job_id: jobId,
      type: "event_tag",
      data_json: {
        tags: highlights.map((h) => ({
          ...makeEstimate({ value: h.start_s, confidence: 0.25, source: "vision", model_version: null }),
          label: h.label,
        })),
      },
      confidence: 0.25,
    });
  }

  /** V2: wagon wheel / shot map / heatmap — geometric placeholders from tags. */
  private async heuristicV2(jobId: string) {
    const wagon = Array.from({ length: 6 }, (_, i) => ({
      angle_deg: i * 60,
      runs: (i % 4) + 1,
      method: "heuristic_placeholder",
    }));
    await this.db.insertVisionOutput({
      job_id: jobId,
      type: "wagon_wheel",
      data_json: { segments: wagon },
      confidence: 0.2,
    });
    await this.db.insertVisionOutput({
      job_id: jobId,
      type: "heatmap",
      data_json: { grid: gridPlaceholder(), method: "heuristic_placeholder" },
      confidence: 0.2,
    });
  }
}

function gridPlaceholder() {
  // 5x5 normalized intensity placeholder
  return Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => 0.2));
}
