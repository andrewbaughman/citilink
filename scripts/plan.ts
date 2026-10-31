import { readFileSync } from 'node:fs';
import { validatePlan, estimatePlan } from '../src/plan';
try {
  const plan = validatePlan(JSON.parse(readFileSync(process.argv[2] ?? 'capture-plan.json','utf8')));
  const estimate = estimatePlan(plan);
  console.table(estimate.datasets);
  console.log(`${estimate.total} base requests/day; ${estimate.optional} optional; ${plan.global.max_requests_per_utc_day - estimate.total} attempts/day headroom.`);
  console.log(estimate.note);
  if (process.argv[3]) {
    const previous = validatePlan(JSON.parse(readFileSync(process.argv[3], 'utf8')));
    console.log('Previous estimate:', estimatePlan(previous).total);
    console.log('Previous -> new plan:');
    for (const id of Object.keys(plan.datasets) as (keyof typeof plan.datasets)[]) if (JSON.stringify(previous.datasets[id]) !== JSON.stringify(plan.datasets[id])) console.log(id, JSON.stringify(previous.datasets[id]), '->', JSON.stringify(plan.datasets[id]));
  }
} catch (error) { console.error((error as Error).message); process.exitCode=1; }
