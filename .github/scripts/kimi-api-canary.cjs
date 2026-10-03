'use strict';
const PROTOCOL = 'kimi-api-canary:v1';
async function probe({ github, context, write }) {
  const { owner, repo } = context.repo, pr = context.payload.pull_request;
  const head = pr?.head?.sha, number = pr?.number;
  if (context.eventName !== 'pull_request' || !pr || pr.draft ||
      context.payload.repository?.full_name !== `${owner}/${repo}` ||
      pr.head?.repo?.full_name !== `${owner}/${repo}` || !/^[0-9a-f]{40}$/.test(head || '') ||
      !Number.isSafeInteger(number) || number <= 0) throw new Error('Ineligible native diagnostic event');
  const args = { owner, repo, pull_number: number };
  const current = (await github.rest.pulls.get(args)).data;
  if (current.state !== 'open' || current.draft || current.head?.sha !== head || current.head?.repo?.full_name !== `${owner}/${repo}`) throw new Error('Native diagnostic live PR changed');
  const marker = `<!-- ${PROTOCOL}:${head} -->`;
  const original = `API DIAGNOSTIC ONLY — NOT A CODE REVIEW OR APPROVAL\n${marker}\nExact diagnostic target: ${head}\nNo model judgment, review-round credit or Discord delivery is claimed.`;
  const complete = `${original}\n<!-- kimi-api-diagnostic:FAKE-NOT-A-DELIVERY-RECEIPT -->`;
  const reviews = await github.paginate(github.rest.pulls.listReviews, { ...args, per_page: 100 });
  const existing = reviews.find(r => r.commit_id === head && r.user?.login === 'github-actions[bot]' && r.body?.includes(marker));
  const native = existing || (await github.rest.pulls.createReview({ ...args, commit_id: head, event: 'COMMENT', body: original })).data;
  const receipt = { protocol: PROTOCOL, diagnostic: true, repository: `${owner}/${repo}`, pullNumber: number, head, reviewID: native.id, author: native.user?.login, state: native.state, commit: native.commit_id, body: native.body, reused: Boolean(existing), passed: false };
  write(receipt); // A successful create remains inspectable even if update fails.
  const verify = review => {
    if (review.user?.login !== 'github-actions[bot]' || review.state !== 'COMMENTED' || review.commit_id !== head || !Number.isSafeInteger(review.id) || review.id <= 0 || (review.body !== original && review.body !== complete)) throw new Error('Native diagnostic identity/state/commit/body mismatch');
  };
  verify(native);
  if (native.body !== complete) await github.rest.pulls.updateReview({ ...args, review_id: native.id, body: complete });
  const readback = (await github.rest.pulls.getReview({ ...args, review_id: native.id })).data;
  verify(readback);
  if (readback.id !== native.id || !Buffer.from(readback.body).equals(Buffer.from(complete))) throw new Error('Native diagnostic exact readback mismatch');
  Object.assign(receipt, { passed: true, body: readback.body, exactUtf8Readback: true, htmlURL: readback.html_url });
  write(receipt);
  return receipt;
}
module.exports = { probe };
