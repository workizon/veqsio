// k6 mixed workload: read-heavy ticketing mix with a ramp-up to VUS virtual users.
//
//   k6 run -e BASE_URL=http://localhost:3000 -e VUS=1000 -e DURATION=300s -e RAMP=60s loadtest/k6/mixed.js
//
// Headline target: 1000 concurrent users. Make sure the API runs with RATE_LIMIT_USER_MAX / RATE_LIMIT_IP_MAX raised
// (default limits are 100 requests/min per user and 1000/min per IP and would answer 429).
import { sleep } from 'k6';
import { loadOptions, scenarios, session, rnd } from './lib.js';

export const options = loadOptions();

// [scenario, weight in percent]; keep in sync with MIX in loadtest/run.ts
const MIX = [
  ['detail', 35], ['search', 25], ['board', 12], ['dashboard', 8], ['comment', 8], ['create', 5], ['login', 2], ['search', 5],
];

function choose() {
  let r = rnd(100);
  for (const [name, weight] of MIX) {
    r -= weight;
    if (r < 0) return name;
  }
  return 'detail';
}

export default function () {
  const name = choose();
  const s = name === 'login' ? {} : session();
  if (!s) {
    sleep(1);
    return;
  }
  scenarios[name](s);
  sleep(0.2 + Math.random() * 0.2);
}
