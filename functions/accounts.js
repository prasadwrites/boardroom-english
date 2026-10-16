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
      isAdmin: u.email === ADMIN_EMAIL && u.emailVerified,
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
  // Make sure the account doc exists (seeded from the user's decks) before patching it.
  await getAccount({ uid, email: target.email, email_verified: target.emailVerified });
  await accountRef(uid).update(patch);
  if ("suspended" in patch) {
    await auth.updateUser(uid, { disabled: patch.suspended });
    if (patch.suspended) await auth.revokeRefreshTokens(uid);
  }
}
