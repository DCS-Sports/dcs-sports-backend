// src/queue/worker.ts
// Worker process. The `agents` lane runs the scheduled Autonomous Agent Layer
// tick (executeTick) — load facts -> compute -> persist via the gate (high-
// stakes stays pending). alerts + vision lanes scaffold as before. Real LLM/CV
// intelligence is DARK (#10); these ticks are deterministic + explainable.
import { Worker } from 'bullmq';
import { QUEUE_NAMES, getConnection, getQueue } from './index';
import { executeTick } from '../agents/runner';

const TICK_EVERY_MS = Number(process.env.AGENT_TICK_MS ?? 15 * 60 * 1000); // 15 min default

async function scheduleAgentTick() {
  // Repeatable job so the tick runs on a cadence without an external cron.
  await getQueue(QUEUE_NAMES.agents).add(
    'agent-tick',
    {},
    { repeat: { every: TICK_EVERY_MS }, removeOnComplete: 100, removeOnFail: 100 }
  );
  console.log(`[dcs-sports] agent tick scheduled every ${TICK_EVERY_MS}ms`);
}

function startWorkers() {
  const connection = getConnection();

  const agents = new Worker(
    QUEUE_NAMES.agents,
    async (job) => {
      if (job.name === 'agent-tick') {
        const result = await executeTick();
        return { tick: result, note: 'suggestions written pending human action on high-stakes' };
      }
      return { handled: job.name };
    },
    { connection }
  );

  const alerts = new Worker(
    QUEUE_NAMES.alerts,
    async (job) => ({ dispatched: job.name, note: 'alert dispatch via Resend (reuse DCS Rank sender)' }),
    { connection }
  );

  const vision = new Worker(
    QUEUE_NAMES.vision,
    async (job) => ({
      received: job.name,
      note: 'CW15 vision intake — heuristic placeholder; CV model DARK (#10)',
    }),
    { connection }
  );

  for (const w of [agents, alerts, vision]) {
    w.on('failed', (job, err) => console.error(`[worker] ${w.name} job ${job?.id} failed:`, err.message));
  }
  console.log('[dcs-sports] workers up: agents (scheduled tick), alerts, vision (money DARK · model DARK)');
}

if (require.main === module) {
  (async () => {
    try {
      startWorkers();
      await scheduleAgentTick();
    } catch (e: any) {
      console.error('[worker] refusing to start unconfigured:', e.message);
      process.exit(1);
    }
  })();
}
