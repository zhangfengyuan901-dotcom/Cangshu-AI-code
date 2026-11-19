'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./admin-client.cjs');

const legalDir = path.join(__dirname, 'legal');
const files = {
  'legal.user_agreement': path.join(legalDir, 'user-agreement.md'),
  'legal.privacy_policy': path.join(legalDir, 'privacy-policy.md'),
};

function loadApprovedDocuments() {
  if (process.env.PIKNO_PUBLISH_LEGAL !== 'I_HAVE_APPROVED_THE_FINAL_TEXT') {
    throw new Error('Set PIKNO_PUBLISH_LEGAL=I_HAVE_APPROVED_THE_FINAL_TEXT only after operator/legal approval');
  }

  return Object.fromEntries(Object.entries(files).map(([key, file]) => {
    if (!fs.existsSync(file)) throw new Error(`Missing approved document: ${path.basename(file)}`);
    const content = fs.readFileSync(file, 'utf8').trim();
    if (content.length < 1000) throw new Error(`Approved document is unexpectedly short: ${path.basename(file)}`);
    if (/【待(?:填写|确认|补充|接入|梳理|核实|由)/.test(content) || /DRAFT/i.test(content)) {
      throw new Error(`Approved document still contains draft markers: ${path.basename(file)}`);
    }
    return [key, content];
  }));
}

async function readStatus(base) {
  const response = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error('Public status check failed');
  return body.data;
}

async function main() {
  const documents = loadApprovedDocuments();
  const base = process.env.NEW_API_BASE || 'http://127.0.0.1:3100';
  const before = await readStatus(base);
  if (before.register_enabled !== false || before.password_register_enabled !== false) {
    throw new Error('Refusing legal publication while registration is open');
  }

  const request = await connect();
  for (const [key, value] of Object.entries(documents)) {
    await request('/api/option/', 'PUT', { key, value });
  }

  const after = await readStatus(base);
  if (after.user_agreement_enabled !== true || after.privacy_policy_enabled !== true) {
    throw new Error('Legal document publication verification failed');
  }
  if (after.register_enabled !== false || after.password_register_enabled !== false) {
    throw new Error('Registration safety invariant changed during legal publication');
  }

  console.log(JSON.stringify({
    published: true,
    userAgreementEnabled: true,
    privacyPolicyEnabled: true,
    registrationOpen: false,
    documentBodiesReturned: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
