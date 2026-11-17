import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import Anthropic from "@anthropic-ai/sdk";
import {
  HttpError, DECK_ID, verifyUser, getAccount, summary, reserve, settle, deleteDeck, listAccounts, updateAccount, isAdmin,
  listDecks, shareDeck,
} from "./accounts.js";
import { makeImage, serveImage } from "./images.js";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

function sendError(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, ...err.extra });
  logger.error("Unexpected error", err);
  return res.status(500).json({ error: "Unexpected error" });
}

const LEVELS = new Set(["B1", "B2", "C1", "C2"]);
const STYLES = new Set(["Mixed", "What does it mean?", "Best thing to say in a situation", "Fill in the blank", "Most formal or natural option"]);
const clip = (v, n) => String(v ?? "").slice(0, n);

const KINDS = ["word", "phrase", "idiom"];
const industryLine = (industry) => industry ? `Industry: the learner works in ${industry}. Prefer vocabulary, situations and examples from that industry.\n` : "";

function buildSwipePrompt({ name, focus, level, industry, kinds }, n, avoid) {
  return `You write vocabulary flashcards for an adult professional building their Business English vocabulary.

Deck: ${name}
Focus: ${focus}
Learner level (CEFR): ${level}
${industryLine(industry)}Teach a mix of: ${kinds.map((k) => k + "s").join(", ")}.

Write exactly ${n} NEW cards. Each teaches one ${kinds.join(", ")} that people really use at work today.
${avoid.length ? `Do not repeat any of these, which the deck already has: ${avoid.join("; ")}` : ""}

Each card has:
- "term": the ${kinds.join(" / ")} itself, 1-6 words.
- "kind": one of ${kinds.map((k) => `"${k}"`).join(", ")}.
- "meaning": its meaning in plain English, under 110 characters.
- "example": one natural sentence using it at work, under 160 characters.
- "options": 4 short meanings, exactly one the closest meaning of the term, the other three plausible but wrong. Each under 90 characters.
- "answer": the index (0-3) of the correct option. Vary its position.
- "mode": "type" for about one card in three, only when the term is one or two words of plain letters; otherwise "choice".
- "scene": a vivid, concrete scene for an illustration that shows the meaning (characters, objects, setting), under 160 characters, with no text or writing in it.
Use straight or curly quotes, no markdown.

Reply with only a JSON array, no other text:
[{"term":"bottleneck","kind":"word","meaning":"The point where work slows down or gets stuck","example":"Approvals are the bottleneck: everything waits for sign-off.","options":["A point where work slows down or gets stuck","The fastest step in a process","A type of packaging","A final quality check"],"answer":0,"mode":"type","scene":"A long queue of tiny cheerful paper documents squeezing through the narrow neck of a giant glass bottle on an office desk"}]`;
}

function buildPrompt({ name, focus, level, style, industry }, n, avoid, slant) {
  return `You write multiple-choice flashcards for an adult professional improving their SPOKEN Business English.

Deck: ${name}
Focus: ${focus}
Learner level (CEFR): ${level}
${industryLine(industry)}Question type: ${style}${style === "Mixed" ? " (vary between meaning, best response in a situation, fill in the blank, and most natural/formal option)" : ""}
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
      industry: clip(body.industry, 60).trim(),
      kinds: Array.isArray(body.kinds) && body.kinds.some((k) => KINDS.includes(k)) ? KINDS.filter((k) => body.kinds.includes(k)) : KINDS,
    };
    const swipe = body.format === "swipe";
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
        messages: [{ role: "user", content: swipe ? buildSwipePrompt(meta, granted, avoid) : buildPrompt(meta, granted, avoid, slant) }],
      });
      const message = await stream.finalMessage();
      const items = message.stop_reason === "refusal" ? null
        : parseArray(message.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
      if (message.stop_reason === "refusal") [status, payload] = [422, { error: "refused" }];
      else if (!Array.isArray(items)) [status, payload] = [502, { error: "Could not parse questions" }];
      else { payload = items.slice(0, granted); used = payload.length; }
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) [status, payload] = [429, { error: "Rate limited" }];
      else if (err instanceof Anthropic.AuthenticationError) { logger.error("The Anthropic API key was rejected"); [status, payload] = [503, { error: "bad_api_key" }]; }
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
        if (route === "/admin/decks" && req.method === "GET") return res.json({ decks: await listDecks() });
        if (route === "/admin/share" && req.method === "POST") {
          const { ownerUid, deckId, ...who } = req.body || {};
          await shareDeck(ownerUid, deckId, who);
          return res.json({ decks: await listDecks() });
        }
      }
      return res.status(404).json({ error: "not_found" });
    } catch (err) { return sendError(res, err); }
  },
);

// POST /api/image {deckId, cardId}: draws the picture for one card of the caller's swipe deck. GET /api/img/...: serves it.
export const image = onRequest(
  { timeoutSeconds: 120, memory: "1GiB", maxInstances: 5, region: "us-central1" },
  async (req, res) => {
    try {
      if (req.method === "GET") return await serveImage(req, res);
      if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
      const user = await verifyUser(req);
      const { deckId, cardId } = req.body || {};
      return res.json(await makeImage(user, String(deckId || ""), String(cardId || "")));
    } catch (err) {
      if (err && err.vertex) { logger.error(err.message); return res.status(502).json({ error: "image_error" }); }
      return sendError(res, err);
    }
  },
);
