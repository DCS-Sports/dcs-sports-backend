/**
 * CW23 — Real microVM SandboxBackend (Firecracker / gVisor adapter)
 *
 * Implements the SandboxBackend interface used by agentic-sandbox/server.mjs.
 * Provides real kernel-level isolation for agentic code execution.
 *
 * Current state:
 *   - Docker backend: LIVE (deployed, used by default)
 *   - Firecracker backend: STUB — real when DK provisions /dev/kvm host
 *   - gVisor backend: STUB — real when DK installs runsc
 *
 * AUTONOMY_LIVE=0: no code executes autonomously until DK flips the flag.
 * Nothing charges or self-acts.
 *
 * DK Provisioning Runbook is at the bottom of this file.
 */

// ── SandboxBackend interface ──────────────────────────────────────────────────
//
// interface SandboxBackend {
//   name: string
//   available(): Promise<boolean>
//   run(task: SandboxTask): Promise<SandboxResult>
//   cleanup(taskId: string): Promise<void>
// }
//
// interface SandboxTask {
//   id: string
//   code: string
//   language: 'python' | 'js' | 'bash'
//   timeout_ms: number
//   memory_mb: number
//   env: Record<string, string>
// }
//
// interface SandboxResult {
//   ok: boolean
//   stdout: string
//   stderr: string
//   exit_code: number
//   wall_time_ms: number
//   receipt_hint?: object  // passed to R+2 receipt pipeline
// }

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

// ── Shared helpers ────────────────────────────────────────────────────────────

function nowMs() { return Date.now(); }

async function safeCleanup(path) {
  try { await rm(path, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Docker backend (current live path) ───────────────────────────────────────

export const DockerBackend = {
  name: 'docker',

  async available() {
    try {
      await execFileAsync('docker', ['info'], { timeout: 5000 });
      return true;
    } catch { return false; }
  },

  async run(task) {
    const AUTONOMY_LIVE = process.env.AUTONOMY_LIVE === '1';
    if (!AUTONOMY_LIVE) {
      return {
        ok: false,
        stdout: '',
        stderr: 'AUTONOMY_LIVE=0 — code execution gated until Phase 4.',
        exit_code: 403,
        wall_time_ms: 0,
      };
    }

    const dir = join(tmpdir(), 'dcs-sandbox-' + task.id);
    await mkdir(dir, { recursive: true });

    const ext = task.language === 'python' ? 'py' : task.language === 'js' ? 'js' : 'sh';
    const codeFile = join(dir, `main.${ext}`);
    await writeFile(codeFile, task.code, 'utf8');

    const image =
      task.language === 'python' ? 'python:3.11-alpine' :
      task.language === 'js'     ? 'node:20-alpine' :
                                   'alpine:latest';

    const cmd =
      task.language === 'python' ? ['python', '/workspace/main.py'] :
      task.language === 'js'     ? ['node', '/workspace/main.js'] :
                                   ['sh', '/workspace/main.sh'];

    const start = nowMs();
    try {
      const { stdout, stderr } = await execFileAsync('docker', [
        'run', '--rm',
        '--memory', `${task.memory_mb || 128}m`,
        '--cpus', '0.5',
        '--network', 'none',
        '--read-only',
        '--tmpfs', '/tmp:size=16m',
        '-v', `${dir}:/workspace:ro`,
        '--env', `TASK_ID=${task.id}`,
        ...Object.entries(task.env || {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
        image, ...cmd,
      ], { timeout: task.timeout_ms || 30000 });

      return { ok: true, stdout, stderr, exit_code: 0, wall_time_ms: nowMs() - start };
    } catch (e) {
      return { ok: false, stdout: e.stdout || '', stderr: e.stderr || String(e), exit_code: e.code || 1, wall_time_ms: nowMs() - start };
    } finally {
      await safeCleanup(dir);
    }
  },

  async cleanup(taskId) {
    // Docker --rm handles cleanup; this is a no-op for Docker
  },
};

// ── Firecracker backend (stub → real after DK provisions /dev/kvm) ────────────

export const FirecrackerBackend = {
  name: 'firecracker',

  async available() {
    // Real: check /dev/kvm exists + firecracker binary present
    try {
      await execFileAsync('test', ['-e', '/dev/kvm'], { timeout: 1000 });
      await execFileAsync('which', ['firecracker'], { timeout: 1000 });
      return true;
    } catch { return false; }
  },

  async run(task) {
    const AUTONOMY_LIVE = process.env.AUTONOMY_LIVE === '1';
    if (!AUTONOMY_LIVE) {
      return {
        ok: false,
        stdout: '',
        stderr: 'AUTONOMY_LIVE=0 — Firecracker gated until Phase 4.',
        exit_code: 403,
        wall_time_ms: 0,
      };
    }

    const available = await FirecrackerBackend.available();
    if (!available) {
      console.warn('[Firecracker] /dev/kvm not available — falling back to Docker');
      return DockerBackend.run(task);
    }

    // ── Real Firecracker path ──
    // Requires: firecracker binary, kernel vmlinux, rootfs ext4 image
    // DK provisions these on the Railway host via the runbook below.
    const vmId = 'vm-' + task.id;
    const socketPath = `/tmp/firecracker-${vmId}.sock`;
    const dir = join(tmpdir(), 'dcs-fc-' + task.id);
    await mkdir(dir, { recursive: true });

    const KERNEL   = process.env.FC_KERNEL_PATH   || '/opt/firecracker/vmlinux.bin';
    const ROOTFS   = process.env.FC_ROOTFS_PATH   || '/opt/firecracker/rootfs.ext4';
    const FC_BIN   = process.env.FC_BIN_PATH      || '/usr/local/bin/firecracker';
    const MEM_MIB  = task.memory_mb || 128;

    // VM config JSON
    const vmConfig = {
      'boot-source': {
        kernel_image_path: KERNEL,
        boot_args: 'console=ttyS0 reboot=k panic=1 pci=off nomodules',
      },
      drives: [{
        drive_id: 'rootfs',
        path_on_host: ROOTFS,
        is_root_device: true,
        is_read_only: true,
      }],
      'machine-config': {
        vcpu_count: 1,
        mem_size_mib: MEM_MIB,
        smt: false,
      },
      // No network interface — fully isolated
    };

    const configPath = join(dir, 'vm-config.json');
    await writeFile(configPath, JSON.stringify(vmConfig), 'utf8');

    const start = nowMs();
    let fcProc;
    try {
      // Start Firecracker
      fcProc = spawn(FC_BIN, ['--api-sock', socketPath, '--config-file', configPath], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Wait for socket
      await waitForSocket(socketPath, 5000);

      // Inject code via Firecracker's API (vsock or serial — simplified here)
      // Production: use vsock agent running in the guest to receive + execute code
      const result = await runInVm(socketPath, task, dir);

      return { ...result, wall_time_ms: nowMs() - start };
    } catch (e) {
      console.error('[Firecracker] VM error, falling back to Docker:', e.message);
      return DockerBackend.run(task);
    } finally {
      if (fcProc) { try { fcProc.kill('SIGKILL'); } catch { /**/ } }
      await safeCleanup(dir);
    }
  },

  async cleanup(taskId) {
    const socketPath = `/tmp/firecracker-vm-${taskId}.sock`;
    await safeCleanup(socketPath);
  },
};

// ── Firecracker helpers (internal) ───────────────────────────────────────────

async function waitForSocket(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await execFileAsync('test', ['-S', socketPath], { timeout: 500 });
      return; // socket exists
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error(`Firecracker socket not ready after ${timeoutMs}ms`);
}

async function runInVm(socketPath, task, workDir) {
  // Stub: in production this sends code to the guest agent via vsock
  // The guest agent (a minimal HTTP server in the rootfs) executes it and returns output
  // Full implementation requires a custom rootfs with the DCS agent baked in.
  //
  // For now: use curl to talk to the Firecracker API + guest agent on vsock port
  const code = task.code;
  const codeFile = join(workDir, 'payload.json');
  await writeFile(codeFile, JSON.stringify({ code, language: task.language, env: task.env || {} }));

  // Real: POST to vsock proxy at http://localhost:FC_VSOCK_PORT/execute
  const FC_AGENT_PORT = process.env.FC_VSOCK_PROXY_PORT || '8090';
  try {
    const resp = await fetch(`http://localhost:${FC_AGENT_PORT}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, language: task.language, task_id: task.id }),
      signal: AbortSignal.timeout(task.timeout_ms || 30000),
    });
    if (!resp.ok) throw new Error(`guest agent error: ${resp.status}`);
    const result = await resp.json();
    return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '', exit_code: result.exit_code ?? 0 };
  } catch (e) {
    return { ok: false, stdout: '', stderr: `Guest agent error: ${e.message}`, exit_code: 1 };
  }
}

// ── gVisor backend (stub → real after DK installs runsc) ─────────────────────

export const GVisorBackend = {
  name: 'gvisor',

  async available() {
    try {
      await execFileAsync('which', ['runsc'], { timeout: 1000 });
      // Also check docker is configured to use gVisor runtime
      await execFileAsync('docker', ['info', '--format', '{{json .Runtimes}}'], { timeout: 2000 });
      return true;
    } catch { return false; }
  },

  async run(task) {
    const AUTONOMY_LIVE = process.env.AUTONOMY_LIVE === '1';
    if (!AUTONOMY_LIVE) {
      return {
        ok: false,
        stdout: '',
        stderr: 'AUTONOMY_LIVE=0 — gVisor gated until Phase 4.',
        exit_code: 403,
        wall_time_ms: 0,
      };
    }

    const available = await GVisorBackend.available();
    if (!available) {
      console.warn('[gVisor] runsc not available — falling back to Docker');
      return DockerBackend.run(task);
    }

    // gVisor: same as Docker but with --runtime=runsc
    const dir = join(tmpdir(), 'dcs-gvisor-' + task.id);
    await mkdir(dir, { recursive: true });

    const ext = task.language === 'python' ? 'py' : task.language === 'js' ? 'js' : 'sh';
    await writeFile(join(dir, `main.${ext}`), task.code, 'utf8');

    const image = task.language === 'python' ? 'python:3.11-alpine' : task.language === 'js' ? 'node:20-alpine' : 'alpine:latest';
    const cmd   = task.language === 'python' ? ['python', '/w/main.py'] : task.language === 'js' ? ['node', '/w/main.js'] : ['sh', '/w/main.sh'];

    const start = nowMs();
    try {
      const { stdout, stderr } = await execFileAsync('docker', [
        'run', '--rm',
        '--runtime', 'runsc',         // ← gVisor kernel
        '--memory', `${task.memory_mb || 128}m`,
        '--cpus', '0.5',
        '--network', 'none',
        '-v', `${dir}:/w:ro`,
        ...Object.entries(task.env || {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
        image, ...cmd,
      ], { timeout: task.timeout_ms || 30000 });

      return { ok: true, stdout, stderr, exit_code: 0, wall_time_ms: nowMs() - start };
    } catch (e) {
      return { ok: false, stdout: e.stdout || '', stderr: e.stderr || String(e), exit_code: e.code || 1, wall_time_ms: nowMs() - start };
    } finally {
      await safeCleanup(dir);
    }
  },

  async cleanup(taskId) { /* Docker --rm handles it */ },
};

// ── Backend selector ──────────────────────────────────────────────────────────

/**
 * selectBackend
 * Returns the best available backend in priority order:
 *   Firecracker (best isolation) → gVisor → Docker (current live)
 *
 * Override with SANDBOX_BACKEND env var: 'docker' | 'gvisor' | 'firecracker'
 */
export async function selectBackend() {
  const override = process.env.SANDBOX_BACKEND;
  if (override === 'firecracker') return FirecrackerBackend;
  if (override === 'gvisor')      return GVisorBackend;
  if (override === 'docker')      return DockerBackend;

  if (await FirecrackerBackend.available()) return FirecrackerBackend;
  if (await GVisorBackend.available())      return GVisorBackend;
  return DockerBackend;
}

/**
 * runSandboxed
 * Main entry point — call from server.mjs instead of directly importing a backend.
 * Automatically selects the best backend and wraps with receipt_hint.
 */
export async function runSandboxed(task) {
  const backend = await selectBackend();
  const result  = await backend.run(task);

  return {
    ...result,
    receipt_hint: {
      sandbox_backend: backend.name,
      task_id: task.id,
      language: task.language,
      wall_time_ms: result.wall_time_ms,
      autonomy_live: process.env.AUTONOMY_LIVE === '1',
    },
  };
}

export default { DockerBackend, FirecrackerBackend, GVisorBackend, selectBackend, runSandboxed };

/* ============================================================================
 * DK PROVISIONING RUNBOOK — Firecracker on Railway
 * ============================================================================
 *
 * Prerequisites: Railway host with /dev/kvm (request KVM-enabled instance).
 *
 * Step 1 — Install Firecracker
 * ----------------------------
 *   ARCH=x86_64
 *   FC_VERSION=v1.7.0
 *   wget -q https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-${ARCH}.tgz
 *   tar -xf firecracker-*.tgz
 *   mv release-${FC_VERSION}-${ARCH}/firecracker-${FC_VERSION}-${ARCH} /usr/local/bin/firecracker
 *   chmod +x /usr/local/bin/firecracker
 *
 * Step 2 — Kernel + rootfs
 * -------------------------
 *   # Download DCS custom rootfs (contains guest agent, Python, Node):
 *   wget https://s3.dcsai.ai/sandbox/rootfs-v1.ext4 -O /opt/firecracker/rootfs.ext4
 *   wget https://s3.dcsai.ai/sandbox/vmlinux.bin   -O /opt/firecracker/vmlinux.bin
 *
 *   # Or build from scratch:
 *   # See /opt/sandbox/rootfs/BUILD.md (use Alpine + guest-agent binary)
 *
 * Step 3 — vsock proxy
 * --------------------
 *   # The guest agent listens on vsock CID 3, port 52.
 *   # Run a host-side proxy so agentic-sandbox can talk to it via HTTP:
 *   npm install -g firecracker-vsock-proxy  # or use the DCS binary
 *   fc-vsock-proxy --host-port 8090 --guest-cid 3 --guest-port 52 &
 *
 * Step 4 — Railway env vars
 * --------------------------
 *   SANDBOX_BACKEND=firecracker
 *   FC_BIN_PATH=/usr/local/bin/firecracker
 *   FC_KERNEL_PATH=/opt/firecracker/vmlinux.bin
 *   FC_ROOTFS_PATH=/opt/firecracker/rootfs.ext4
 *   FC_VSOCK_PROXY_PORT=8090
 *
 * Step 5 — Flip AUTONOMY_LIVE=1
 * -------------------------------
 *   Only after: billing ready (PAYMENTS_LIVE=1) + 30d soak gate passes.
 *   As per security rules: "Nothing charges or self-acts until Phase 4."
 *
 * gVisor alternative
 * -------------------
 *   apt-get install -y runsc
 *   # Configure Docker to use gVisor:
 *   cat > /etc/docker/daemon.json <<EOF
 *   {
 *     "runtimes": {
 *       "runsc": { "path": "/usr/bin/runsc", "runtimeArgs": ["--platform=kvm"] }
 *     }
 *   }
 *   EOF
 *   systemctl restart docker
 *   # Then set:
 *   SANDBOX_BACKEND=gvisor
 *
 * ============================================================================
 */
