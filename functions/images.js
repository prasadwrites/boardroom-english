// Pictures for swipe-deck cards: drawn by Gemini image on Vertex AI, shrunk to a small WebP and kept in Firestore at images/{uid~deckId~cardId}.
// Each card gets at most one picture, only for cards inside the account's plan, and the prompt is built here from the stored card.
import sharp from "sharp";
import { db, HttpError, DECK_ID, getAccount } from "./accounts.js";

const PROJECT = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "boardroom-english";
const MODEL = "gemini-2.5-flash-image";
const BASE = process.env.VERTEX_BASE_URL || `https://us-central1-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/us-central1/publishers/google/models`;
export const CARD_ID = /^q\d{1,4}$/;
const UID = /^[A-Za-z0-9]{1,128}$/;
const imageRef = (uid, deckId, cardId) => db.collection("images").doc(`${uid}~${deckId}~${cardId}`);

async function accessToken() {
  if (process.env.VERTEX_BASE_URL) return "test";
  const res = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error("metadata token " + res.status);
  return (await res.json()).access_token;
}

function promptFor(card) {
  const kind = ["word", "phrase", "idiom"].includes(card.kind) ? card.kind : "expression";
  return `Create a picture that illustrates the meaning of the English ${kind} "${String(card.term).slice(0, 80)}" (meaning: ${String(card.meaning || "").slice(0, 160)}).
Scene: ${String(card.scene || card.example || "").slice(0, 240)}
Style: a still from a charming 3D animated family film. Soft, rounded, stylised characters with big expressive eyes, warm cinematic lighting, gentle depth of field, rich but soft colours, clean uncluttered background. Square composition.
Do not include any text, letters, numbers, captions, speech bubbles or signs with writing.`;
}

// Makes the picture for one card of the caller's own swipe deck, unless it already exists.
export async function makeImage(user, deckId, cardId) {
  if (!DECK_ID.test(deckId) || !CARD_ID.test(cardId)) throw new HttpError(400, "bad_request");
  const ref = imageRef(user.uid, deckId, cardId);
  if ((await ref.get()).exists) return { ok: true, existed: true };
  const account = await getAccount(user);
  if (account.suspended) throw new HttpError(403, "suspended");
  if (Number(cardId.slice(1)) >= ((account.decks || {})[deckId] || 0)) throw new HttpError(403, "limit_questions");
  const deck = (await db.doc(`users/${user.uid}/items/deck-${deckId}`).get()).data();
  const card = deck && deck.format === "swipe" && Array.isArray(deck.questions) ? deck.questions.find((q) => q && q.id === cardId) : null;
  if (!card || !card.term) throw new HttpError(404, "not_found");

  const res = await fetch(`${BASE}/${MODEL}:generateContent`, {
    method: "POST",
    headers: { Authorization: "Bearer " + (await accessToken()), "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: promptFor(card) }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new HttpError(429, "rate_limited");
  if (!res.ok) throw Object.assign(new Error(`Vertex AI ${res.status}: ${data.error && data.error.message}`), { vertex: true });
  const part = ((data.candidates || [])[0]?.content?.parts || []).find((p) => p.inlineData && p.inlineData.data);
  if (!part) throw new HttpError(422, "no_image");
  const webp = await sharp(Buffer.from(part.inlineData.data, "base64")).resize(560, 560, { fit: "cover" }).webp({ quality: 74 }).toBuffer();
  await ref.set({ data: webp, mime: "image/webp", uid: user.uid, deckId, cardId, createdAt: Date.now() });
  return { ok: true };
}

// GET /api/img/{uid}/{deckId}/{cardId}: the stored picture. Pictures are not private; the path is only known to people who can see the deck.
export async function serveImage(req, res) {
  const [uid, deckId, cardId] = req.path.replace(/^\/api\/img\//, "").split("/");
  if (!UID.test(uid || "") || !DECK_ID.test(deckId || "") || !CARD_ID.test(cardId || "")) return res.status(404).set("Cache-Control", "no-store").end();
  const snap = await imageRef(uid, deckId, cardId).get();
  if (!snap.exists) return res.status(404).set("Cache-Control", "no-store").end();
  const v = snap.data();
  res.set("Cache-Control", "public, max-age=31536000, immutable").type(v.mime || "image/webp").send(Buffer.from(v.data));
}
