// k6 scenario: login. Run: k6 run -e BASE_URL=http://localhost:3000 -e VUS=100 loadtest/k6/login.js
import { sleep } from 'k6';
import { loadOptions, scenarios, session } from './lib.js'; // eslint-disable-line no-unused-vars

export const options = loadOptions();

export default function () {
  const s = {};
  if (!s) return;
  scenarios.login(s);
  sleep(0.3 + Math.random() * 0.4);
}
