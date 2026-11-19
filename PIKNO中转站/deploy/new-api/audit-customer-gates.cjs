'use strict';

const { connect } = require('./admin-client.cjs');

const relevantKey = /(register|verification|turnstile|agreement|privacy|quota|invite|smtp|serveraddress)/i;
const secretKey = /(secret|smtp.*token|private.*key)/i;

async function main() {
  const request = await connect();
  const [options, status] = await Promise.all([
    request('/api/option/'),
    fetch(`${process.env.NEW_API_BASE || 'http://127.0.0.1:3100'}/api/status`, {
      signal: AbortSignal.timeout(10000),
    }).then((response) => response.json()),
  ]);

  const selected = options
    .filter(({ key }) => relevantKey.test(key))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ key, value }) => ({
      key,
      value: secretKey.test(key) ? (String(value || '').length > 0 ? '[configured]' : '[empty]') : value,
    }));

  console.log(JSON.stringify({
    healthy: status.success === true,
    publicGates: {
      registerEnabled: status.data?.register_enabled,
      passwordRegisterEnabled: status.data?.password_register_enabled,
      emailVerification: status.data?.email_verification,
      turnstileCheck: status.data?.turnstile_check,
      userAgreementEnabled: status.data?.user_agreement_enabled,
      privacyPolicyEnabled: status.data?.privacy_policy_enabled,
    },
    options: selected,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
