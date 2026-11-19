import { writeFileSync } from 'node:fs';

export default class RouterUpgradeErrorsReporter {
  onTestRunEnd(_modules, errors, reason) {
    writeFileSync('upgrade-runtime-errors.json', JSON.stringify({ unhandledErrors: errors.length, reason }));
  }
}
