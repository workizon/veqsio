// k6 scenario: search. Run: k6 run -e BASE_URL=http://localhost:3000 -e VUS=100 loadtest/k6/search.js
import { sleep } from 'k6';
import { loadOptions, scenarios, session } from './lib.js';

export const options = loadOptions();

export default function () {
  const s = session();
  if (!s) return;
  scenarios.search(s);
  sleep(0.3 + Math.random() * 0.4);
}
