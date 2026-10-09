// Sign-in for the Firebase-hosted site: Google or email/password accounts, with each user's decks and piles kept in Firestore.
// The page itself (src/app.html) exposes window.boardroom.attachStore / detachStore; this file only supplies the account and the store.
import { initializeApp } from "firebase/app";
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendPasswordResetEmail, signOut,
} from "firebase/auth";
import { initializeFirestore, collection, doc, getDocs, setDoc, deleteDoc } from "firebase/firestore";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Same collection/doc shape as the Claude artifact store, so the page's sync code works unchanged.
function storeFor(fs) {
  return {
    collection: (path) => ({
      get: async () => ({ docs: (await getDocs(collection(fs, path))).docs.map((d) => ({ id: d.id, data: () => d.data() })) }),
      doc: (id) => ({ set: (body) => setDoc(doc(fs, path, id), body), delete: () => deleteDoc(doc(fs, path, id)) }),
    }),
  };
}

const MESSAGES = {
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/missing-password": "Enter your password.",
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/wrong-password": "Email or password is incorrect.",
  "auth/user-not-found": "No account uses that email. Choose Create account instead.",
  "auth/email-already-in-use": "An account already uses that email. Choose Sign in instead.",
  "auth/weak-password": "Use a password of at least 6 characters.",
  "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
  "auth/network-request-failed": "Couldn't reach the sign-in service. Check your connection.",
  "auth/popup-blocked": "Your browser blocked the Google window. Allow pop-ups for this site and try again.",
  "auth/operation-not-allowed": "This sign-in method isn't switched on for the site yet.",
  "auth/configuration-not-found": "Sign-in isn't set up for this site yet.",
};
const friendly = (e) => MESSAGES[e && e.code] || "Something went wrong signing in. Please try again.";

function buildDialog() {
  const dlg = document.createElement("dialog");
  dlg.className = "signin";
  dlg.setAttribute("aria-labelledby", "signin-title");
  dlg.innerHTML = `
    <form method="dialog" novalidate>
      <button class="close" type="button" data-auth="close" aria-label="Close">×</button>
      <h2 id="signin-title">Sign in to keep your decks</h2>
      <p>Your decks and your Repeat and Learned piles are saved to your account, so they're there on any device.</p>
      <button class="btn google" type="button" data-auth="google">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
        Continue with Google
      </button>
      <div class="or">or use your email</div>
      <div class="field"><label for="auth-email">Email</label><input id="auth-email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="auth-pass">Password</label><input id="auth-pass" type="password" autocomplete="current-password" minlength="6" required></div>
      <div class="msg" hidden role="status"></div>
      <div class="row">
        <button class="btn primary" type="submit" data-auth="signin">Sign in</button>
        <button class="btn" type="button" data-auth="create">Create account</button>
      </div>
      <button class="linkish" type="button" data-auth="reset">Forgot password?</button>
    </form>`;
  document.body.appendChild(dlg);
  return dlg;
}

async function main() {
  const accountEl = $("#account");
  if (!accountEl || !window.boardroom) return;
  let config;
  try {
    const res = await fetch("/__/firebase/init.json");
    if (!res.ok) throw new Error("no config");
    config = await res.json();
  } catch (e) { console.warn("Firebase config unavailable; accounts are off", e); return; }

  const app = initializeApp(config);
  const auth = getAuth(app);
  const store = storeFor(initializeFirestore(app, { ignoreUndefinedProperties: true }));
  const dlg = buildDialog();
  const msg = $(".msg", dlg), email = $("#auth-email", dlg), pass = $("#auth-pass", dlg);
  const say = (text, ok) => { msg.hidden = !text; msg.textContent = text || ""; msg.className = "msg " + (ok ? "ok" : "err"); };
  const busy = (on) => dlg.querySelectorAll("button").forEach((b) => (b.disabled = on));
  let attachedUid = null;

  async function run(fn) {
    say(""); busy(true);
    try { await fn(); } catch (e) { if (e && e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") say(friendly(e)); }
    finally { busy(false); }
  }
  function needCreds() {
    if (!email.value.trim() || !pass.value) { say("Enter your email and a password."); return false; }
    return true;
  }

  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) return dlg.close();
    const b = e.target.closest("[data-auth]"); if (!b) return;
    const act = b.dataset.auth;
    if (act === "close") dlg.close();
    else if (act === "google") run(() => signInWithPopup(auth, new GoogleAuthProvider()));
    else if (act === "create") { if (needCreds()) run(() => createUserWithEmailAndPassword(auth, email.value.trim(), pass.value)); }
    else if (act === "reset") {
      if (!email.value.trim()) return say("Enter your email first, then choose Forgot password.");
      run(async () => { await sendPasswordResetEmail(auth, email.value.trim()); say("Check your inbox for a link to reset your password.", true); });
    }
  });
  dlg.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (needCreds()) run(() => signInWithEmailAndPassword(auth, email.value.trim(), pass.value));
  });

  accountEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-auth]"); if (!b) return;
    if (b.dataset.auth === "open") { say(""); dlg.showModal(); email.focus(); }
    else if (b.dataset.auth === "signout") signOut(auth);
  });

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      if (dlg.open) dlg.close();
      accountEl.innerHTML = `<span class="who">${esc(user.email || user.displayName || "Signed in")}</span><button class="btn ghost" type="button" data-auth="signout">Sign out</button>`;
      if (attachedUid === user.uid) return;
      attachedUid = user.uid;
      try { await window.boardroom.attachStore(store, `users/${user.uid}/items`, "Saved to your account"); }
      catch (e) { console.warn("Couldn't load your account's decks", e); $("#sync").textContent = "Couldn't reach your account. Using this browser"; }
    } else {
      accountEl.innerHTML = `<button class="btn primary" type="button" data-auth="open">Sign in</button>`;
      if (attachedUid) { attachedUid = null; window.boardroom.detachStore(); }
    }
  });
}

main();
