import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const read = async path => JSON.parse(await readFile(path, 'utf8'));
const baseline = await read('scripts/upgrade42-baseline-failures.json');
const current = await read('upgrade-full-test-result.json');
const runtime = await read('upgrade-runtime-errors.json');
const failures = report => report.testResults.flatMap(file => file.assertionResults
  .filter(test => test.status === 'failed')
  .map(test => ({ file: file.name.slice(file.name.indexOf('/src/')), name: test.fullName,
    firstMessage: test.failureMessages?.[0]?.split('\n')[0] ?? '' })))
  .sort((a, b) => `${a.file}:${a.name}`.localeCompare(`${b.file}:${b.name}`));
assert.equal(Number(process.argv[2]), 1, 'Unexpected test process status');
assert.equal(baseline.numFailedTests, 5, 'Baseline failure set changed');
assert.equal(baseline.numTotalTests, 19, 'Baseline test coverage changed');
assert.equal(current.numTotalTests, 2384, 'Tests were lost or not discovered');
assert.equal(current.testResults.length, 206, 'Test files were lost or not discovered');
assert.equal(current.numFailedTests, 5, 'Unexpected failed test count');
assert.equal(current.numPassedTests, 2379, 'Unexpected passed test count');
assert.equal(current.numPendingTests, 0);
assert.equal(current.numTodoTests, 0);
assert.equal(runtime.unhandledErrors, 0, 'Unhandled test runtime errors');
assert.equal(runtime.reason, 'failed', 'Unexpected test-run completion status');
assert.deepEqual(failures(current), failures(baseline), 'A new failure or changed baseline failure was introduced');
for (const file of current.testResults) {
  if (file.status === 'failed') assert.ok(file.assertionResults.some(test => test.status === 'failed'), 'Unexpected suite initialization failure');
}
const result = { success: true, allTestsRun: true, total: current.numTotalTests, passed: current.numPassedTests,
  knownBaselineFailures: failures(current), newFailures: 0, skipped: current.numPendingTests,
  unhandledErrors: runtime.unhandledErrors, unexpectedProcessExit: false };
await writeFile('upgrade-suite-verification.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
