import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import Anthropic from "@anthropic-ai/sdk";
import {
  HttpError, DECK_ID, verifyUser, getAccount, summary, reserve, settle, deleteDeck, listAccounts, updateAccount, isAdmin,
} from "./accounts.js";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

function sendError(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, ...err.extra });
  logger.error("Unexpected error", err);
  return res.status(500).json({ error: "Unexpected error" });
}

const LEVELS = new Set(["B1", "B2", "C1", "C2"]);
const STYLES = new Set(["Mixed", "What does it mean?", "Best thing to say in a situation", "Fill in the blank", "Most formal or natural option"]);
const clip = (v, n) => String(v ?? "").slice(0, n);

function buildPrompt({ name, focus, level, style }, n, avoid, slant) {
  return `You write multiple-choice flashcards for an adult professional improving their SPOKEN Business English.

Deck: ${name}
Focus: ${focus}
Learner level (CEFR): ${level}
Question type: ${style}${style === "Mixed" ? " (vary between meaning, best response in a situation, fill in the blank, and most natural/formal option)" : ""}
Where it fits the focus, lean toward this setting for this batch: ${slant}.

Write exactly ${n} NEW questions. Each tests one item (a phrase, word, idiom, collocation or response) that people really say at work today.
${avoid.length ? `Do not test any of these items, which the deck already covers: ${avoid.join("; ")}` : ""}

Rules:
- 4 options per question, exactly one clearly correct; the other three plausible but wrong (common learner mistakes, wrong meanings, wrong register).
- Vary which position holds the correct option.
- Question under 180 characters. Options under 100 characters each.
- "explain": one or two short sentences on why the answer is right, ideally with a natural example sentence.
- "term": the item being tested, 1-5 words.
- Use straight or curly quotes, no markdown.

Reply with only a JSON array, no other text:
[{"term":"touch base","q":"\\"Let's touch base next week.\\" What does the speaker want?","options":["To briefly check in","To sign the contract","To restart the project","To cancel the meeting"],"answer":0,"explain":"Touch base = have a short catch-up."}]`;
}

function parseArray(text) {
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a !== -1 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  return null;
}

// POST /api/generate: a batch of questions for one deck. Needs a signed-in, non-suspended account with room left on its plan.
export const generate = onRequest(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 300, memory: "512MiB", maxInstances: 5, region: "us-central1" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
    const body = req.body || {};
    const meta = {
      name: clip(body.name, 60) || "My deck",
      focus: clip(body.focus, 600),
      level: LEVELS.has(body.level) ? body.level : "B2",
      style: STYLES.has(body.style) ? body.style : "Mixed",
    };
    if (!meta.focus.trim()) return res.status(400).json({ error: "Focus is required" });
    const deckId = String(body.deckId || "");
    if (!DECK_ID.test(deckId)) return res.status(400).json({ error: "deckId is required" });
    const want = Math.max(1, Math.min(25, Number(body.n) || 25));
    const avoid = Array.isArray(body.avoid) ? body.avoid.slice(-200).map((t) => clip(t, 80)) : [];
    const slant = clip(body.slant, 80) || "meetings and presentations";

    let user, granted;
    try {
      user = await verifyUser(req);
      granted = await reserve(user, deckId, want, clip(body.code, 60));
    } catch (err) { return sendError(res, err); }

    // Settle the reservation before replying: the function may stop running once the response is sent.
    let status = 200, payload, used = 0;
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    try {
      const stream = client.beta.messages.stream({
        model: "claude-opus-5-5",
        max_tokens: 32000,
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content: buildPrompt(meta, granted, avoid, slant) }],
      });
      const message = await stream.finalMessage();
      const items = message.stop_reason === "refusal" ? null
        : parseArray(message.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
      if (message.stop_reason === "refusal") [status, payload] = [422, { error: "refused" }];
      else if (!Array.isArray(items)) [status, payload] = [502, { error: "Could not parse questions" }];
      else { payload = items.slice(0, granted); used = payload.length; }
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) [status, payload] = [429, { error: "Rate limited" }];
      else if (err instanceof Anthropic.APIError && /credit balance/i.test(err.message)) { logger.error("Anthropic account is out of credit"); [status, payload] = [402, { error: "no_credit" }]; }
      else if (err instanceof Anthropic.APIError) { logger.error("Claude API error", err.status, err.message); [status, payload] = [502, { error: "Claude API error" }]; }
      else { logger.error("Unexpected error", err); [status, payload] = [500, { error: "Unexpected error" }]; }
    }
    await settle(user, deckId, granted, used).catch((e) => logger.error("Couldn't settle reservation", e));
    return res.status(status).json(payload);
  },
);

// /api/account/*: the signed-in user's plan and usage, deck deletion, and (for the admin) managing every account.
export const account = onRequest(
  { timeoutSeconds: 60, memory: "256MiB", maxInstances: 5, region: "us-central1" },
  async (req, res) => {
    try {
      const user = await verifyUser(req);
      const route = req.path.replace(/^\/api\/account/, "").replace(/\/+$/, "") || "/";
      if (route === "/me" && req.method === "GET") return res.json(summary(await getAccount(user), user));
      if (route === "/delete-deck" && req.method === "POST") {
        const deckId = String((req.body || {}).deckId || "");
        if (!DECK_ID.test(deckId)) throw new HttpError(400, "bad_request");
        await deleteDeck(user, deckId);
        return res.json(summary(await getAccount(user), user));
      }
      if (route.startsWith("/admin")) {
        if (!isAdmin(user)) throw new HttpError(403, "not_admin");
        if (route === "/admin/users" && req.method === "GET") return res.json({ users: await listAccounts() });
        if (route === "/admin/update" && req.method === "POST") {
          const { uid, ...changes } = req.body || {};
          await updateAccount(user, uid, changes);
          return res.json({ users: await listAccounts() });
        }
      }
      return res.status(404).json({ error: "not_found" });
    } catch (err) { return sendError(res, err); }
  },
);
