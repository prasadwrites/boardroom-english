// Admin page: every account with its plan, usage, access code and suspension. Only the admin's account can load the data;
// the server checks that on every request (functions/accounts.js), so this page only decides what to show.
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, onAuthStateChanged } from "firebase/auth";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PLANS = { free: "Free", pro: "Pro", promax: "Pro Max" };
const LIMITS = { free: [5, 20], pro: [50, 120], promax: [100, 200] };
const ERRORS = { cant_suspend_self: "You can't suspend your own account.", not_admin: "Only the admin can do that.", bad_plan: "Unknown plan." };

let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600); }
const when = (s) => { if (!s) return "never"; const d = new Date(s); return isNaN(d) ? "never" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); };

let auth, me, users = [], filter = "", planFilter = "all";

async function api(path, body) {
  const res = await fetch("/api/account/admin" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + (await auth.currentUser.getIdToken()), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "error"), { code: data.error, status: res.status });
  return data;
}

function notice(html) { $("#main").innerHTML = `<div class="notice">${html}</div>`; }

function render() {
  const q = filter.toLowerCase();
  const shown = users.filter((u) => (planFilter === "all" || (planFilter === "suspended" ? u.suspended : u.plan === planFilter))
    && (!q || u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)));
  const count = (f) => users.filter(f).length;
  $("#main").innerHTML = `
    <h2>Accounts</h2>
    <p class="lede">Change a plan, give an account its own access code for creating decks, or suspend it. Changes apply straight away.</p>
    <div class="stats">
      <div class="stat"><b>${users.length}</b><span>accounts</span></div>
      <div class="stat"><b>${count((u) => u.plan === "free")}</b><span>Free</span></div>
      <div class="stat"><b>${count((u) => u.plan === "pro")}</b><span>Pro</span></div>
      <div class="stat"><b>${count((u) => u.plan === "promax")}</b><span>Pro Max</span></div>
      <div class="stat"><b>${count((u) => u.suspended)}</b><span>suspended</span></div>
    </div>
    <div class="tools">
      <input id="search" type="search" placeholder="Search by email or name" aria-label="Search accounts" value="${esc(filter)}">
      <select id="plan-filter" aria-label="Show">
        ${[["all", "All accounts"], ["free", "Free"], ["pro", "Pro"], ["promax", "Pro Max"], ["suspended", "Suspended"]].map(([v, l]) => `<option value="${v}" ${v === planFilter ? "selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <div class="list">${shown.length ? shown.map(card).join("") : `<div class="notice"><p>No accounts match.</p></div>`}</div>`;
  const s = $("#search"); s.addEventListener("input", () => { filter = s.value; const pos = s.selectionStart; render(); const n = $("#search"); n.focus(); n.setSelectionRange(pos, pos); });
  $("#plan-filter").addEventListener("change", (e) => { planFilter = e.target.value; render(); });
}

function card(u) {
  const [maxD, maxQ] = LIMITS[u.plan] || LIMITS.free;
  const self = u.uid === me.uid;
  return `<article class="acct ${u.suspended ? "off" : ""}" data-uid="${esc(u.uid)}">
    <div class="id">
      <div class="email">${esc(u.email || "(no email)")}${u.isAdmin ? `<span class="badge admin">Admin</span>` : ""}${u.suspended ? `<span class="badge off">Suspended</span>` : ""}</div>
      <div class="meta">${u.name ? esc(u.name) + " · " : ""}${esc(u.providers.join(", ") || "")} · joined ${when(u.created)} · last seen ${when(u.lastSignIn)}</div>
    </div>
    <div class="field">
      <label for="plan-${esc(u.uid)}">Plan</label>
      <select id="plan-${esc(u.uid)}" data-do="plan">${Object.entries(PLANS).map(([v, l]) => `<option value="${v}" ${v === u.plan ? "selected" : ""}>${l}</option>`).join("")}</select>
      <span class="usage"><b>${u.decksUsed}</b> of ${maxD} decks · ${u.questionsUsed} questions (max ${maxQ} per deck)</span>
    </div>
    <div class="field code">
      <label for="code-${esc(u.uid)}">Access code for creating decks</label>
      <div class="code-row"><input id="code-${esc(u.uid)}" value="${esc(u.code)}" placeholder="None needed" autocomplete="off" maxlength="60"><button class="btn" type="button" data-do="code">Save</button></div>
    </div>
    <div class="act">${self ? "" : `<button class="btn ${u.suspended ? "" : "danger"}" type="button" data-do="suspend">${u.suspended ? "Restore" : "Suspend"}</button>`}</div>
  </article>`;
}

async function update(uid, changes, done) {
  try { users = (await api("/update", { uid, ...changes })).users; render(); toast(done); }
  catch (e) { toast(ERRORS[e.code] || "Couldn't save that change. Try again."); render(); }
}

document.addEventListener("change", (e) => {
  if (e.target.dataset.do !== "plan") return;
  const uid = e.target.closest("[data-uid]").dataset.uid;
  update(uid, { plan: e.target.value }, "Plan updated");
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-do]"); if (!b) return;
  const row = b.closest("[data-uid]"); const uid = row.dataset.uid; const u = users.find((x) => x.uid === uid);
  if (b.dataset.do === "code") update(uid, { code: row.querySelector("input").value.trim() }, "Access code saved");
  if (b.dataset.do === "suspend") {
    if (!u.suspended && !confirm(`Suspend ${u.email}? They'll be signed out and can't sign in or create decks until you restore the account.`)) return;
    b.disabled = true;
    update(uid, { suspended: !u.suspended }, u.suspended ? "Account restored" : "Account suspended");
  }
});

async function main() {
  let config;
  try { config = await (await fetch("/__/firebase/init.json")).json(); }
  catch { return notice(`<p>This page only works on the live site.</p>`); }
  auth = getAuth(initializeApp(config));
  if (["localhost", "127.0.0.1"].includes(location.hostname)) connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  onAuthStateChanged(auth, async (user) => {
    me = user;
    $("#who").textContent = user ? user.email || "" : "";
    if (!user) return notice(`<p>Sign in with the admin account on the main page first.</p><a class="btn primary" href="/">Go to Boardroom English</a>`);
    try { users = (await api("/users")).users; render(); }
    catch (e) {
      if (e.status === 403) notice(`<p>This page is only for the site admin.</p><a class="btn" href="/">Back to the decks</a>`);
      else notice(`<p>Couldn't load the accounts. Reload to try again.</p>`);
    }
  });
}
main();
