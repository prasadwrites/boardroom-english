import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
// Optional: set GENERATE_ACCESS_CODE so only people with the code can spend your API credit.
const GENERATE_ACCESS_CODE = defineSecret("GENERATE_ACCESS_CODE");

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

export const generate = onRequest(
  { secrets: [ANTHROPIC_API_KEY, GENERATE_ACCESS_CODE], timeoutSeconds: 300, memory: "512MiB", maxInstances: 5, region: "us-central1" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
    const required = GENERATE_ACCESS_CODE.value();
    const body = req.body || {};
    if (required && required !== "off" && body.code !== required) return res.status(401).json({ error: "Access code required" });

    const meta = {
      name: clip(body.name, 60) || "My deck",
      focus: clip(body.focus, 600),
      level: LEVELS.has(body.level) ? body.level : "B2",
      style: STYLES.has(body.style) ? body.style : "Mixed",
    };
    if (!meta.focus.trim()) return res.status(400).json({ error: "Focus is required" });
    const n = Math.max(1, Math.min(25, Number(body.n) || 25));
    const avoid = Array.isArray(body.avoid) ? body.avoid.slice(-200).map((t) => clip(t, 80)) : [];
    const slant = clip(body.slant, 80) || "meetings and presentations";

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    try {
      const stream = client.beta.messages.stream({
        model: "claude-opus-5-5",
        max_tokens: 32000,
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content: buildPrompt(meta, n, avoid, slant) }],
      });
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") return res.status(422).json({ error: "refused" });
      const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const items = parseArray(text);
      if (!Array.isArray(items)) return res.status(502).json({ error: "Could not parse questions" });
      return res.json(items);
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "Rate limited" });
      if (err instanceof Anthropic.APIError && /credit balance/i.test(err.message)) { logger.error("Anthropic account is out of credit"); return res.status(402).json({ error: "no_credit" }); }
      if (err instanceof Anthropic.APIError) { logger.error("Claude API error", err.status, err.message); return res.status(502).json({ error: "Claude API error" }); }
      logger.error("Unexpected error", err);
      return res.status(500).json({ error: "Unexpected error" });
    }
  },
);
