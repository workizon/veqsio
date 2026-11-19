// k6 scenario: detail. Run: k6 run -e BASE_URL=http://localhost:3000 -e VUS=100 loadtest/k6/issue-detail.js
import { sleep } from 'k6';
import { loadOptions, scenarios, session } from './lib.js';

export const options = loadOptions();

export default function () {
  const s = session();
  if (!s) return;
  scenarios.detail(s);
  sleep(0.3 + Math.random() * 0.4);
}
