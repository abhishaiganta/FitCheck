// Starts the 3D worker (the GitHub Actions workflow .github/workflows/worker.yml) on demand,
// so a Sell upload doesn't wait for GitHub's unreliable cron schedule.
// Needs GITHUB_DISPATCH_TOKEN: a fine-grained token for this repo only, with "Actions: read and write".
import { logError } from '@/lib/errors';

const API = 'https://api.github.com';
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
let lastCheck = 0;

function cfg() {
  return {
    token: process.env.GITHUB_DISPATCH_TOKEN ?? '',
    repo: process.env.GITHUB_WORKER_REPO || 'abhishaiganta/FitCheck',
    workflow: process.env.GITHUB_WORKER_WORKFLOW || 'worker.yml',
    ref: process.env.GITHUB_WORKER_REF || 'main',
  };
}

async function gh(path: string, init: RequestInit = {}) {
  const { token } = cfg();
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fitcheck-worker-trigger',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(8000),
  });
}

/**
 * Make sure a worker run is queued or running. Never throws: a failed trigger only means
 * the item waits for the next scheduled run.
 * minIntervalMs throttles repeat calls from one server instance (the /sell page polls).
 */
export async function ensureWorker(minIntervalMs = 0): Promise<'started' | 'running' | 'skipped'> {
  const { token, repo, workflow, ref } = cfg();
  if (!token) return 'skipped';
  const now = Date.now();
  if (minIntervalMs && now - lastCheck < minIntervalMs) return 'skipped';
  lastCheck = now;
  try {
    const runs = await gh(`/repos/${repo}/actions/workflows/${workflow}/runs?per_page=5`);
    if (runs.ok) {
      const j = (await runs.json()) as { workflow_runs?: { status: string }[] };
      if (j.workflow_runs?.some((r) => ACTIVE.has(r.status))) return 'running';
    }
    const res = await gh(`/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref }),
    });
    if (!res.ok) throw new Error(`GitHub dispatch HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return 'started';
  } catch (e) {
    logError('worker.trigger', e);
    return 'skipped';
  }
}
