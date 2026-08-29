// Ad-hoc IMAP debug helper for inspecting OpenAI verification emails.
// Credentials come from env — never hardcode them:
//   GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD='xxxx xxxx xxxx xxxx' node scripts/debug-emails.cjs
const { ImapFlow } = require("imapflow");

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error("Set GMAIL_USER and GMAIL_APP_PASSWORD env vars before running.");
  process.exit(1);
}

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com", port: 993, secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false, socketTimeout: 10000, connectionTimeout: 10000,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = await client.search({ subject: "temporary ChatGPT" });
    console.log("Found:", uids?.length);
    const uid = uids[uids.length - 1];
    const msg = await client.fetchOne(uid, { source: true, envelope: true });
    console.log("Subject:", msg.envelope?.subject);
    console.log("To:", msg.envelope?.to?.[0]?.address);
    const full = msg.source?.toString("utf8") || "";
    // Print lines containing a 6-digit number
    const lines = full.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/\d{6}/.test(lines[i])) {
        console.log(`line ${i}: ${lines[i].slice(0, 200)}`);
      }
    }
    // Also try matching the whole thing
    const m = full.match(/\d{6}/g);
    console.log("\nAll 6-digit matches:", m);
  } finally { lock.release(); await client.logout(); }
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
