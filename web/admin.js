// Admin page: every account with its plan, usage, access code and suspension. Only the admin's account can load the data;
// the server checks that on every request (functions/accounts.js), so this page only decides what to show.
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, onAuthStateChanged } from "firebase/auth";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PLANS = { free: "Free", pro: "Pro", promax: "Pro Max" };
const LIMITS = { free: [5, 20], pro: [50, 120], promax: [100, 200] };
const ERRORS = { landing_too_small: "A landing deck needs at least 15 cards.", cant_suspend_self: "You can't suspend your own account.", not_admin: "Only the admin can do that.", bad_plan: "Unknown plan.", not_found: "That deck no longer exists." };
const STARTERS = [["b-phrases", "Business Phrases"], ["b-vocab", "Core Vocabulary"], ["b-meetings", "Meetings & Calls"]];

let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600); }
const when = (s) => { if (!s) return "never"; const d = new Date(s); return isNaN(d) ? "never" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); };

const tabFromHash = () => (["#decks", "#requests"].includes(location.hash) ? location.hash.slice(1) : "accounts");
let requests = [], reqFilter = "open";
let auth, me, users = [], decks = [], filter = "", planFilter = "all", tab = tabFromHash(), deckFilter = "", deckFormat = "all", deckIndustry = "all";
const emailOf = (uid) => (users.find((u) => u.uid === uid) || {}).email || "unknown account";

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

function tabs() {
  return `<div class="tabs" role="tablist">
    <button class="tab" role="tab" aria-selected="${tab === "accounts"}" data-tab="accounts">Accounts (${users.length})</button>
    <button class="tab" role="tab" aria-selected="${tab === "decks"}" data-tab="decks">Decks (${decks.length})</button>
    <button class="tab" role="tab" aria-selected="${tab === "requests"}" data-tab="requests">Requests${openCount() ? `<span class="count-badge">${openCount()}</span>` : ""}</button></div>`;
}
const openCount = () => requests.filter((r) => r.status === "open").length;
function render() { if (tab === "decks") renderDecks(); else if (tab === "requests") renderRequests(); else renderAccounts(); }

// Requests: people who paid for Premium (or pressed Pay now) and people asking for more decks.
function renderRequests() {
  const shown = requests.filter((r) => reqFilter === "all" || r.status === reqFilter);
  const kind = { premium: "Premium payment", decks: "More decks" };
  $("#main").innerHTML = `${tabs()}
    <p class="lede">Premium requests come from people who pressed Pay now. Check the payment in your Square dashboard, then make the account Premium. Deck requests come from people who have learned at least 80% of their cards.</p>
    <div class="tools"><select id="req-filter" aria-label="Show">${[["open", "Open"], ["done", "Done"], ["dismissed", "Dismissed"], ["all", "All"]].map(([v, l]) => `<option value="${v}" ${v === reqFilter ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="list">${shown.length ? shown.map((r, i) => {
      const u = users.find((x) => x.uid === r.uid) || {};
      return `<article class="acct req-row" data-rid="${esc(r.id)}" style="--i:${i + 2}">
        <div class="id"><div class="email">${esc(u.email || r.email || "unknown account")}<span class="badge ${r.type === "premium" ? "premium" : "admin"}">${kind[r.type] || r.type}</span>${r.status !== "open" ? `<span class="badge off">${esc(r.status)}</span>` : ""}</div>
          <div class="meta">${when(r.createdAt)}${r.type === "decks" && r.share ? ` · ${Math.round(r.share * 100)}% learned` : ""}${u.premium ? " · already Premium" : ""}</div>
          ${r.message ? `<div class="meta">“${esc(r.message)}”</div>` : ""}</div>
        <div class="act">${r.status === "open" ? `${r.type === "premium" && !u.premium ? `<button class="btn primary" type="button" data-do="make-premium" data-uid="${esc(r.uid)}">Make Premium</button>` : ""}
          <button class="btn" type="button" data-do="req-done">Mark done</button><button class="btn ghost" type="button" data-do="req-dismiss">Dismiss</button>` : `<button class="btn ghost" type="button" data-do="req-reopen">Reopen</button>`}</div>
      </article>`; }).join("") : `<div class="notice"><p>${reqFilter === "open" ? "No open requests." : "Nothing here."}</p></div>`}</div>`;
  $("#req-filter").addEventListener("change", (e) => { reqFilter = e.target.value; render(); });
}
async function setRequest(id, status, done) {
  try { requests = (await api("/request", { id, status })).requests; render(); toast(done); }
  catch (e) { toast("Couldn't save that change. Try again."); render(); }
}
// Switching tabs adds a history entry (#decks), so the browser's Back button returns to the other tab and then to the app.
function show(t) { tab = t; render(); const m = $("#main"); m.classList.remove("enter"); void m.offsetWidth; m.classList.add("enter"); }
addEventListener("hashchange", () => { if (users.length) show(tabFromHash()); });
function renderAccounts() {
  const q = filter.toLowerCase();
  const shown = users.filter((u) => (planFilter === "all" || (planFilter === "suspended" ? u.suspended : planFilter === "premium" ? u.premium : !u.premium))
    && (!q || u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)));
  const count = (f) => users.filter(f).length;
  $("#main").innerHTML = `${tabs()}
    <p class="lede">Make an account Premium, set the deck it opens first, or suspend it. Changes apply straight away.</p>
    <div class="stats">
      <div class="stat" style="--i:1"><b>${users.length}</b><span>accounts</span></div>
      <div class="stat" style="--i:1"><b>${count((u) => !u.premium && !u.isAdmin)}</b><span>Free</span></div>
      <div class="stat" style="--i:1"><b>${count((u) => u.premium)}</b><span>Premium</span></div>
      <div class="stat" style="--i:1"><b>${count((u) => u.suspended)}</b><span>suspended</span></div>
      <div class="stat" style="--i:1"><b>${openCount()}</b><span>open requests</span></div>
    </div>
    <div class="tools">
      <input id="search" type="search" placeholder="Search by email or name" aria-label="Search accounts" value="${esc(filter)}">
      <select id="plan-filter" aria-label="Show">
        ${[["all", "All accounts"], ["free", "Free"], ["premium", "Premium"], ["suspended", "Suspended"]].map(([v, l]) => `<option value="${v}" ${v === planFilter ? "selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <div class="list">${shown.length ? shown.map(card).join("") : `<div class="notice"><p>No accounts match.</p></div>`}</div>`;
  const s = $("#search"); s.addEventListener("input", () => { filter = s.value; const pos = s.selectionStart; render(); const n = $("#search"); n.focus(); n.setSelectionRange(pos, pos); });
  $("#plan-filter").addEventListener("change", (e) => { planFilter = e.target.value; render(); });
}

function renderDecks() {
  const q = deckFilter.toLowerCase();
  const industries = [...new Set(decks.map((d) => d.industry).filter(Boolean))].sort();
  const shown = decks.filter((d) => (deckFormat === "all" || (deckFormat === "shared" ? d.shared : d.format === deckFormat))
    && (deckIndustry === "all" || (deckIndustry === "" ? !d.industry : d.industry === deckIndustry))
    && (!q || d.name.toLowerCase().includes(q) || emailOf(d.ownerUid).toLowerCase().includes(q)));
  $("#main").innerHTML = `${tabs()}
    <p class="lede">Make a deck public so everyone signed in sees it, mark it Premium so only Premium accounts can play it (others see it locked), or assign it to particular accounts. The landing deck is what visitors play before signing up. Saving again updates the shared copy.</p>
    <div class="tools">
      <input id="dsearch" type="search" placeholder="Search by deck name or owner" aria-label="Search decks" value="${esc(deckFilter)}">
      <select id="dformat" aria-label="Deck type">${[["all", "All decks"], ["quiz", "Quiz decks"], ["swipe", "Swipe decks"], ["shared", "Shared"]].map(([v, l]) => `<option value="${v}" ${v === deckFormat ? "selected" : ""}>${l}</option>`).join("")}</select>
      <select id="dindustry" aria-label="Industry"><option value="all">Any industry</option><option value="" ${deckIndustry === "" ? "selected" : ""}>General</option>${industries.map((i) => `<option ${i === deckIndustry ? "selected" : ""}>${esc(i)}</option>`).join("")}</select>
    </div>
    <div class="list">${shown.length ? shown.map(deckCard).join("") : `<div class="notice"><p>${decks.length ? "No decks match." : "Nobody has made a deck yet."}</p></div>`}</div>`;
  const s = $("#dsearch"); s.addEventListener("input", () => { deckFilter = s.value; const pos = s.selectionStart; render(); const n = $("#dsearch"); n.focus(); n.setSelectionRange(pos, pos); });
  $("#dformat").addEventListener("change", (e) => { deckFormat = e.target.value; render(); });
  $("#dindustry").addEventListener("change", (e) => { deckIndustry = e.target.value; render(); });
}

function deckCard(d) {
  const stale = d.shared && d.sharedCards !== d.cards;
  const who = users.filter((u) => u.uid !== d.ownerUid);
  return `<article class="acct deck-row" data-sid="${esc(d.sid)}" style="--i:${decks.indexOf(d) + 2}">
    <div class="id">
      <div class="email">${esc(d.name)}<span class="badge ${d.format === "swipe" ? "swipe" : "admin"}">${d.format === "swipe" ? "Swipe" : "Quiz"}</span>${d.landing ? `<span class="badge landing">Landing</span>` : ""}${d.public ? `<span class="badge pub">Public</span>` : ""}${d.premium ? `<span class="badge premium">Premium</span>` : ""}</div>
      <div class="meta">${esc(emailOf(d.ownerUid))} · ${d.cards} cards${d.level ? " · " + esc(d.level) : ""} · ${esc(d.industry || "General")}</div>
      ${stale ? `<div class="meta warn">The shared copy has ${d.sharedCards} cards. Save to share all ${d.cards}.</div>` : ""}
    </div>
    <div class="field">
      <label><input type="checkbox" data-f="public" ${d.public || d.landing ? "checked" : ""} ${d.landing ? "disabled" : ""}> Public: everyone signed in</label>
      <label><input type="checkbox" data-f="premium" ${d.premium ? "checked" : ""} ${d.landing ? "disabled" : ""}> Premium only</label>
      <label title="${d.cards < 15 ? "A landing deck needs at least 15 cards" : "Visitors play 10 of its questions before signing up"}"><input type="checkbox" data-f="landing" ${d.landing ? "checked" : ""} ${d.cards < 15 ? "disabled" : ""}> Landing deck${d.cards < 15 ? " (needs 15+ cards)" : ""}</label>
    </div>
    <div class="field">
      <details class="assign"><summary>${d.assignees.length ? `Assigned to ${d.assignees.length} account${d.assignees.length > 1 ? "s" : ""}` : "Assign to accounts"}</summary>
        <div class="who-list">${who.length ? who.map((u) => `<label><input type="checkbox" data-f="assignee" value="${esc(u.uid)}" ${d.assignees.includes(u.uid) ? "checked" : ""}> ${esc(u.email || u.name || u.uid)}</label>`).join("") : `<span class="usage">No other accounts yet.</span>`}</div>
      </details>
    </div>
    <div class="act"><button class="btn primary" type="button" data-do="share">Save</button></div>
  </article>`;
}
function defaultOptions(u) {
  const mine = decks;
  const opt = (v, l) => `<option value="${esc(v)}" ${v === (u.defaultDeck || "") ? "selected" : ""}>${esc(l)}</option>`;
  const known = !u.defaultDeck || u.defaultDeck.startsWith("builtin:") || decks.some((d) => d.sid === u.defaultDeck);
  return opt("", "None") + `<optgroup label="Starter decks">${STARTERS.map(([id, n]) => opt("builtin:" + id, n)).join("")}</optgroup>`
    + (mine.length ? `<optgroup label="Decks people made">${mine.map((d) => opt(d.sid, `${d.name} (${d.format === "swipe" ? "swipe" : "quiz"}, ${d.ownerUid === u.uid ? "their own" : emailOf(d.ownerUid)})`)).join("")}</optgroup>` : "")
    + (known ? "" : opt(u.defaultDeck, "A deck that was deleted"));
}

function card(u) {
  const [maxD, maxQ] = LIMITS[u.plan] || LIMITS.free;
  const self = u.uid === me.uid;
  return `<article class="acct ${u.suspended ? "off" : ""}" data-uid="${esc(u.uid)}" style="--i:${users.indexOf(u) + 2}">
    <div class="id">
      <div class="email">${esc(u.email || "(no email)")}${u.isAdmin ? `<span class="badge admin">Admin</span>` : ""}${u.premium ? `<span class="badge premium">Premium</span>` : ""}${u.suspended ? `<span class="badge off">Suspended</span>` : ""}</div>
      <div class="meta">${u.name ? esc(u.name) + " · " : ""}${esc(u.providers.join(", ") || "")} · joined ${when(u.created)} · last seen ${when(u.lastSignIn)}</div>
    </div>
    <div class="field">
      ${u.isAdmin ? `<label>Deck making</label><span class="usage"><b>${u.decksUsed}</b> of ${maxD} decks · up to ${maxQ} cards each</span>` : `
      <label for="tier-${esc(u.uid)}">Tier</label>
      <select id="tier-${esc(u.uid)}" data-do="tier"><option value="free" ${u.premium ? "" : "selected"}>Free</option><option value="premium" ${u.premium ? "selected" : ""}>Premium</option></select>`}
    </div>
    <div class="field">
      <label for="def-${esc(u.uid)}">Default deck</label>
      <select id="def-${esc(u.uid)}" data-do="default">${defaultOptions(u)}</select>
    </div>
    <div class="act">${self ? "" : `<button class="btn ${u.suspended ? "" : "danger"}" type="button" data-do="suspend">${u.suspended ? "Restore" : "Suspend"}</button>`}</div>
  </article>`;
}

async function update(uid, changes, done) {
  try {
    users = (await api("/update", { uid, ...changes })).users;
    if ("defaultDeck" in changes) decks = (await api("/decks")).decks;
    render(); toast(done);
  } catch (e) { toast(ERRORS[e.code] || "Couldn't save that change. Try again."); render(); }
}
async function share(row) {
  const d = decks.find((x) => x.sid === row.dataset.sid); if (!d) return;
  const f = (k) => row.querySelector(`[data-f="${k}"]`).checked;
  const body = { ownerUid: d.ownerUid, deckId: d.deckId, public: f("public"), premium: f("premium"), landing: f("landing"),
    assignees: [...row.querySelectorAll('[data-f="assignee"]:checked')].map((x) => x.value) };
  try { decks = (await api("/share", body)).decks; render(); toast(body.landing ? "Saved. Visitors now start with this deck" : body.public || body.assignees.length ? "Sharing saved" : "Deck is no longer shared"); }
  catch (e) { toast(ERRORS[e.code] || "Couldn't save that change. Try again."); render(); }
}

document.addEventListener("change", (e) => {
  if (e.target.dataset.f === "landing") {
    const row = e.target.closest("[data-sid]"), pub = row.querySelector('[data-f="public"]'), pre = row.querySelector('[data-f="premium"]');
    if (e.target.checked) { pub.checked = true; pre.checked = false; }
    pub.disabled = pre.disabled = e.target.checked;
  }
  const what = e.target.dataset.do; if (what !== "tier" && what !== "default") return;
  const uid = e.target.closest("[data-uid]").dataset.uid;
  if (what === "tier") update(uid, { premium: e.target.value === "premium" }, e.target.value === "premium" ? "Account is now Premium" : "Account is now Free");
  else update(uid, { defaultDeck: e.target.value }, e.target.value ? "Default deck set" : "Default deck removed");
});
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-tab]"); if (t) { if (t.dataset.tab !== tab) location.hash = t.dataset.tab === "accounts" ? "" : t.dataset.tab; return; }
  const b = e.target.closest("button[data-do]"); if (!b) return;
  if (b.dataset.do === "share") { b.disabled = true; return share(b.closest("[data-sid]")); }
  if (b.dataset.do === "make-premium") {
    b.disabled = true; const rid = b.closest("[data-rid]").dataset.rid;
    return update(b.dataset.uid, { premium: true }, "Account is now Premium").then(() => setRequest(rid, "done", "Account is now Premium"));
  }
  if (["req-done", "req-dismiss", "req-reopen"].includes(b.dataset.do)) {
    const st = { "req-done": "done", "req-dismiss": "dismissed", "req-reopen": "open" }[b.dataset.do];
    b.disabled = true; return setRequest(b.closest("[data-rid]").dataset.rid, st, st === "open" ? "Reopened" : st === "done" ? "Marked done" : "Dismissed");
  }
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
    try { [users, decks, requests] = await Promise.all([api("/users").then((r) => r.users), api("/decks").then((r) => r.decks), api("/requests").then((r) => r.requests)]); show(tab); }
    catch (e) {
      if (e.status === 403) notice(`<p>This page is only for the site admin.</p><a class="btn" href="/">Back to the decks</a>`);
      else notice(`<p>Couldn't load the accounts. Reload to try again.</p>`);
    }
  });
}
main();
