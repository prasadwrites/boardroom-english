// Accounts: plans, per-account access codes, suspension and the deck/question ledger that deck generation is checked against.
// Account docs live at accounts/{uid}. Only this server writes them; signed-in users may read their own (see firestore.rules).
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
export const auth = getAuth();
export const db = getFirestore();

export const ADMIN_EMAIL = "prasad.writes@gmail.com";
export const PLANS = {
  free: { label: "Free", decks: 5, questions: 20 },
  pro: { label: "Pro", decks: 50, questions: 120 },
  promax: { label: "Pro Max", decks: 100, questions: 200 },
};
export const DECK_ID = /^[A-Za-z0-9_-]{1,40}$/;

export class HttpError extends Error {
  constructor(status, code, extra = {}) { super(code); this.status = status; this.code = code; this.extra = extra; }
}

const accountRef = (uid) => db.collection("accounts").doc(uid);
export const isAdmin = (user) => user.email === ADMIN_EMAIL && user.email_verified === true;

// Verifies the caller's Firebase ID token. Disabled (suspended) users are rejected here too.
export async function verifyUser(req) {
  const m = /^Bearer (.+)$/.exec(req.get("Authorization") || "");
  if (!m) throw new HttpError(401, "signin_required");
  try { return await auth.verifyIdToken(m[1], true); }
  catch (e) {
    if (e && e.code === "auth/user-disabled") throw new HttpError(403, "suspended");
    throw new HttpError(401, "signin_required");
  }
}

// A new account starts on Free (the admin on Pro Max), with any decks already in the user's store counted against it.
async function seedAccount(user) {
  const decks = {};
  const snap = await db.collection(`users/${user.uid}/items`).get();
  snap.docs.forEach((d) => {
    const v = d.data();
    if (d.id.startsWith("deck-") && v && Array.isArray(v.questions) && DECK_ID.test(String(v.id))) decks[v.id] = v.questions.length;
  });
  return { email: user.email || "", plan: isAdmin(user) ? "promax" : "free", suspended: false, code: "", decks, createdAt: Date.now() };
}

export async function getAccount(user) {
  const ref = accountRef(user.uid);
  const snap = await ref.get();
  if (snap.exists) {
    const a = snap.data();
    if (user.email && a.email !== user.email) await ref.update({ email: user.email });
    return a;
  }
  const a = await seedAccount(user);
  await ref.create(a).catch(() => {}); // a parallel request may have created it first
  return (await ref.get()).data();
}

export function summary(a, user) {
  const plan = PLANS[a.plan] || PLANS.free;
  const decks = a.decks || {};
  return {
    email: a.email, plan: a.plan in PLANS ? a.plan : "free", planLabel: plan.label,
    maxDecks: plan.decks, maxQuestions: plan.questions, decksUsed: Object.keys(decks).length, decks,
    needsCode: !!a.code, suspended: !!a.suspended, isAdmin: user ? isAdmin(user) : false,
    uid: user ? user.uid : undefined, defaultDeck: a.defaultDeck || "", premium: !!a.premium,
  };
}

// Reserves up to n questions for deckId inside the plan's limits, before Claude is called. Returns how many were granted.
export async function reserve(user, deckId, n, code) {
  await getAccount(user);
  const ref = accountRef(user.uid);
  return db.runTransaction(async (tx) => {
    const a = (await tx.get(ref)).data();
    if (a.suspended) throw new HttpError(403, "suspended");
    if (a.code && code !== a.code) throw new HttpError(401, "needs_code");
    const plan = PLANS[a.plan] || PLANS.free;
    const decks = a.decks || {};
    const isNew = !(deckId in decks);
    if (isNew && Object.keys(decks).length >= plan.decks) throw new HttpError(403, "limit_decks", { maxDecks: plan.decks, plan: plan.label });
    const have = decks[deckId] || 0;
    const granted = Math.min(n, plan.questions - have);
    if (granted <= 0) throw new HttpError(403, "limit_questions", { maxQuestions: plan.questions, plan: plan.label });
    tx.update(ref, new FieldPath("decks", deckId), have + granted);
    return granted;
  });
}

// Gives back the part of a reservation Claude didn't use. A brand-new deck that got nothing doesn't keep its slot.
export async function settle(user, deckId, granted, used) {
  if (used >= granted) return;
  const ref = accountRef(user.uid);
  await db.runTransaction(async (tx) => {
    const a = (await tx.get(ref)).data();
    const now = ((a.decks || {})[deckId] || 0) - (granted - used);
    tx.update(ref, new FieldPath("decks", deckId), now > 0 ? now : FieldValue.delete());
  });
}

// Deleting a deck frees its slot. The deck's documents are removed here too, so the slot can't be reused while the deck stays.
export async function deleteDeck(user, deckId) {
  await getAccount(user);
  const items = db.collection(`users/${user.uid}/items`);
  const batch = db.batch();
  batch.delete(items.doc("deck-" + deckId));
  batch.delete(items.doc("prog-" + deckId));
  batch.update(accountRef(user.uid), new FieldPath("decks", deckId), FieldValue.delete());
  await batch.commit();
  // Its pictures go too, unless the admin shared the deck: the shared copy still shows them.
  if (!(await db.collection("shared").doc(sharedId(user.uid, deckId)).get()).exists) {
    const pics = await db.collection("images").where("uid", "==", user.uid).where("deckId", "==", deckId).get();
    for (let i = 0; i < pics.docs.length; i += 400) {
      const b = db.batch(); pics.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref)); await b.commit();
    }
  }
}

// ---------- sharing ----------
// The admin can share any account's deck. shared/{ownerUid~deckId} holds what the deck is and who sees it (public, premium,
// assignees); the cards themselves are in shared/{sid}/content/deck, which only people allowed to play it can read.
// The landing deck (one at most) is also copied to config/landing, which visitors can read without signing in. See firestore.rules.
export const sharedId = (ownerUid, deckId) => `${ownerUid}~${deckId}`;
const BUILTIN_DECKS = { "b-phrases": 25, "b-vocab": 25, "b-meetings": 20 };
export const LANDING_MIN = 15;
const snapshot = (v) => ({
  id: v.id, name: v.name || "Deck", focus: v.focus || "", level: v.level || "", style: v.style || "", color: v.color || "",
  format: v.format === "swipe" ? "swipe" : "quiz", industry: v.industry || "", questions: v.questions,
});
const meta = (v) => ({ name: v.name || "Deck", focus: v.focus || "", level: v.level || "", format: v.format === "swipe" ? "swipe" : "quiz", industry: v.industry || "", color: v.color || "", cards: v.questions.length });
const sharedCards = (s) => (s ? (typeof s.cards === "number" ? s.cards : s.deck ? s.deck.questions.length : 0) : 0);

export async function listDecks() {
  const shares = {};
  (await db.collection("shared").get()).docs.forEach((d) => (shares[d.id] = d.data()));
  const landing = ((await db.doc("config/landing").get()).data() || {}).sid || "";
  const decks = [];
  (await db.collectionGroup("items").get()).docs.forEach((d) => {
    const owner = d.ref.parent.parent;
    if (!d.id.startsWith("deck-") || !owner || owner.parent.id !== "users") return;
    const v = d.data();
    if (!v || !Array.isArray(v.questions) || !DECK_ID.test(String(v.id))) return;
    const sid = sharedId(owner.id, v.id), s = shares[sid];
    decks.push({
      sid, ownerUid: owner.id, deckId: v.id, ...meta(v), createdAt: v.createdAt || 0,
      public: !!(s && s.public), premium: !!(s && s.premium), landing: sid === landing,
      assignees: (s && s.assignees) || [], shared: !!s, sharedCards: sharedCards(s),
    });
  });
  return decks.sort((a, b) => b.createdAt - a.createdAt);
}

// Sets who can see a deck, whether it's premium, and whether it's the landing deck. Saving also refreshes the shared copy.
export async function shareDeck(ownerUid, deckId, { public: isPublic, premium, landing, assignees } = {}) {
  if (typeof ownerUid !== "string" || !ownerUid || !DECK_ID.test(String(deckId))) throw new HttpError(400, "bad_request");
  const v = (await db.doc(`users/${ownerUid}/items/deck-${deckId}`).get()).data();
  if (!v || !Array.isArray(v.questions)) throw new HttpError(404, "not_found");
  const sid = sharedId(ownerUid, deckId);
  const people = [...new Set((Array.isArray(assignees) ? assignees : []).filter((u) => typeof u === "string" && u && u.length <= 128))].slice(0, 2000);
  const landingRef = db.doc("config/landing");
  const wasLanding = ((await landingRef.get()).data() || {}).sid === sid;
  if (landing) {
    if (v.questions.length < LANDING_MIN) throw new HttpError(400, "landing_too_small", { min: LANDING_MIN });
    isPublic = true; premium = false; // visitors play it for free, and so does everyone after signing in
  }
  const ref = db.collection("shared").doc(sid);
  if (!isPublic && !people.length) {
    if (wasLanding) await landingRef.delete();
    await ref.collection("content").doc("deck").delete();
    return ref.delete();
  }
  const batch = db.batch();
  batch.set(ref, { ownerUid, deckId, public: !!isPublic, premium: !!premium, assignees: people, ...meta(v), updatedAt: Date.now() });
  batch.set(ref.collection("content").doc("deck"), { deck: snapshot(v), updatedAt: Date.now() });
  if (landing) batch.set(landingRef, { sid, ownerUid, deckId, deck: snapshot(v), updatedAt: Date.now() });
  else if (wasLanding) batch.delete(landingRef);
  await batch.commit();
}

// A user's default deck is "builtin:<id>", a shared deck id (ownerUid~deckId) or "" for none.
async function checkDefault(uid, value) {
  if (!value) return "";
  if (typeof value !== "string") throw new HttpError(400, "bad_request");
  if (value.startsWith("builtin:")) { if (!(value.slice(8) in BUILTIN_DECKS)) throw new HttpError(400, "bad_deck"); return value; }
  const [ownerUid, deckId] = value.split("~");
  const ref = db.collection("shared").doc(sharedId(ownerUid, deckId));
  const snap = await ref.get();
  if (snap.exists && snap.data().deck === undefined) {
    const s = snap.data();
    if (!s.public && !(s.assignees || []).includes(uid)) await ref.update({ assignees: FieldValue.arrayUnion(uid) });
  } else {
    const s = snap.exists ? snap.data() : {};
    await shareDeck(ownerUid, deckId, { public: !!s.public, premium: !!s.premium, assignees: [...new Set([...(s.assignees || []), uid])] });
  }
  return sharedId(ownerUid, deckId);
}

// ---------- requests to the admin ----------
// requests/{id}: {type: "premium" | "decks", uid, email, message, status: "open" | "done" | "dismissed", createdAt}.
// The admin sees open ones on the admin page and as a count on the Admin link.
export async function openRequests() { return (await db.collection("requests").where("status", "==", "open").get()).size; }

export async function requestPremium(user) {
  const a = await getAccount(user);
  if (a.suspended) throw new HttpError(403, "suspended");
  if (a.premium) return { ok: true, already: true };
  const open = await db.collection("requests").where("uid", "==", user.uid).where("status", "==", "open").get();
  const mine = open.docs.find((d) => d.data().type === "premium");
  if (mine) { await mine.ref.update({ createdAt: Date.now() }); return { ok: true }; }
  await db.collection("requests").add({ type: "premium", uid: user.uid, email: user.email || "", message: "", status: "open", createdAt: Date.now() });
  return { ok: true };
}

// Share of all the cards this person can play that are in their Learned pile.
export async function learnedShare(user, account) {
  const premium = !!account.premium;
  const sizes = { ...BUILTIN_DECKS };
  const col = db.collection("shared");
  const [pub, mine, items] = await Promise.all([col.where("public", "==", true).get(), col.where("assignees", "array-contains", user.uid).get(), db.collection(`users/${user.uid}/items`).get()]);
  [...pub.docs, ...mine.docs].forEach((d) => {
    const s = d.data();
    if (s.premium && !premium && !(s.assignees || []).includes(user.uid)) return;
    sizes["sh-" + d.id] = sharedCards(s);
  });
  const progress = {};
  items.docs.forEach((d) => {
    const v = d.data() || {};
    if (d.id.startsWith("deck-") && Array.isArray(v.questions) && v.id) sizes[v.id] = v.questions.length;
    else if (d.id.startsWith("prog-")) progress[d.id.slice(5)] = v.cards || {};
  });
  let total = 0, learned = 0;
  for (const [id, n] of Object.entries(sizes)) {
    total += n;
    learned += Math.min(n, Object.values(progress[id] || {}).filter((p) => p && p.l).length);
  }
  return { total, learned, share: total ? learned / total : 0 };
}

export async function requestDecks(user, message) {
  const a = await getAccount(user);
  if (a.suspended) throw new HttpError(403, "suspended");
  const { share } = await learnedShare(user, a);
  if (share < 0.8) throw new HttpError(403, "not_enough_learned", { share });
  const open = await db.collection("requests").where("uid", "==", user.uid).where("status", "==", "open").get();
  if (open.docs.some((d) => d.data().type === "decks")) throw new HttpError(409, "already_requested");
  await db.collection("requests").add({ type: "decks", uid: user.uid, email: user.email || "", message: String(message || "").trim().slice(0, 500), share, status: "open", createdAt: Date.now() });
  return { ok: true };
}

export async function listRequests() {
  const snap = await db.collection("requests").orderBy("createdAt", "desc").limit(200).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
export async function closeRequest(id, status) {
  if (typeof id !== "string" || !id || !["done", "dismissed", "open"].includes(status)) throw new HttpError(400, "bad_request");
  const ref = db.collection("requests").doc(id);
  if (!(await ref.get()).exists) throw new HttpError(404, "not_found");
  await ref.update({ status, closedAt: Date.now() });
}

// ---------- admin ----------
export async function listAccounts() {
  const users = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    users.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  const accounts = {};
  (await db.collection("accounts").get()).docs.forEach((d) => (accounts[d.id] = d.data()));
  return users.map((u) => {
    const a = accounts[u.uid] || { plan: u.email === ADMIN_EMAIL ? "promax" : "free", decks: {}, code: "", suspended: false };
    const decks = a.decks || {};
    return {
      uid: u.uid, email: u.email || "", name: u.displayName || "",
      providers: u.providerData.map((p) => (p.providerId === "google.com" ? "Google" : p.providerId === "password" ? "Email" : p.providerId)),
      created: u.metadata.creationTime || "", lastSignIn: u.metadata.lastSignInTime || "",
      plan: a.plan in PLANS ? a.plan : "free", code: a.code || "", suspended: !!(a.suspended || u.disabled),
      decksUsed: Object.keys(decks).length, questionsUsed: Object.values(decks).reduce((s, n) => s + (n || 0), 0),
      isAdmin: u.email === ADMIN_EMAIL && u.emailVerified, defaultDeck: a.defaultDeck || "", premium: !!a.premium,
    };
  }).sort((x, y) => (y.lastSignIn ? Date.parse(y.lastSignIn) : 0) - (x.lastSignIn ? Date.parse(x.lastSignIn) : 0));
}

export async function updateAccount(admin, uid, changes) {
  if (typeof uid !== "string" || !uid) throw new HttpError(400, "bad_request");
  const target = await auth.getUser(uid).catch(() => null);
  if (!target) throw new HttpError(404, "not_found");
  const patch = {};
  if ("plan" in changes) {
    if (!(changes.plan in PLANS)) throw new HttpError(400, "bad_plan");
    patch.plan = changes.plan;
  }
  if ("code" in changes) patch.code = String(changes.code || "").trim().slice(0, 60);
  if ("suspended" in changes) {
    if (uid === admin.uid) throw new HttpError(400, "cant_suspend_self");
    patch.suspended = !!changes.suspended;
  }
  if ("premium" in changes) patch.premium = !!changes.premium;
  if ("defaultDeck" in changes) patch.defaultDeck = await checkDefault(uid, changes.defaultDeck);
  // Make sure the account doc exists (seeded from the user's decks) before patching it.
  await getAccount({ uid, email: target.email, email_verified: target.emailVerified });
  await accountRef(uid).update(patch);
  if ("suspended" in patch) {
    await auth.updateUser(uid, { disabled: patch.suspended });
    if (patch.suspended) await auth.revokeRefreshTokens(uid);
  }
}
