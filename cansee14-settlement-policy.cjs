'use strict';
// Executable design reference, NOT connected to the production wallet.
// Receipt authentication/ownership must be verified by a server-side adapter.
// Never accept receipt fields or `verified` from a customer request.
function decide({ status, taskId, accountRef, receipt, quotedQuota }) {
  const review = reason => ({ action: 'review', reason });
  if (!['succeeded', 'failed'].includes(status)) return review('task_not_terminal');
  if (!receipt || receipt.verified !== true || receipt.final !== true || !receipt.id) return review('missing_final_verified_receipt');
  if (receipt.taskId !== taskId || receipt.accountRef !== accountRef) return review('receipt_ownership_mismatch');
  if (!Number.isSafeInteger(quotedQuota) || quotedQuota < 0) return review('invalid_quote');
  // This first implementation design accepts whole points only. Unknown
  // precision/currency cannot silently fall through to a guessed charge.
  const { chargedPoints, refundedPoints, pointsPerYuan } = receipt;
  if (![chargedPoints, refundedPoints, pointsPerYuan].every(Number.isSafeInteger) || chargedPoints < 0 || refundedPoints < 0 || refundedPoints > chargedPoints || pointsPerYuan !== 100) return review('unsupported_cost_basis');
  const net = BigInt(chargedPoints) - BigInt(refundedPoints);
  const multiplier = status === 'succeeded' ? 2n : 1n;
  const denominator = BigInt(pointsPerYuan);
  const target = (net * multiplier * 1000000n + denominator/2n) / denominator;
  if (target > BigInt(quotedQuota)) return review('charge_exceeds_accepted_quote');
  return { action: 'settle', targetQuota: Number(target), releaseQuota: quotedQuota-Number(target), multiplier: Number(multiplier), receiptId: receipt.id, policyVersion: 'cansee-failed-cost-v1' };
}
module.exports = { decide };
