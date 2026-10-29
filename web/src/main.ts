import "./style.css";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { PAYERS, PROVIDER_TYPES, SERVICES, labelOf } from "./catalog";
import { formatDate, recommend, replyText, type Profile, type Recommendation } from "./match";
import { supabase } from "./supabase";

// ---------------------------------------------------------------------------
// Types and state
// ---------------------------------------------------------------------------

type Role = "owner" | "admin" | "staff";
type Agency = { id: string; name: string; provider_type: string; role: Role };
type Referral = {
  id: string;
  received_at: string;
  source: string | null;
  source_contact: string | null;
  patient_initials: string | null;
  age: number | null;
  diagnosis: string | null;
  needs: string[];
  payer: string | null;
  location: string | null;
  start_date: string | null;
  notes: string | null;
  status: "open" | "accepted" | "declined";
  recommendation: Recommendation | null;
  reply_text: string | null;
  responded_at: string | null;
};
type View = "queue" | "new" | "profile" | "team" | "activity";

const SLA_MS = 15 * 60 * 1000;
const IDLE_MS = 15 * 60 * 1000;

// Supabase reads and clears the URL hash on load, so note invite and reset links first.
const arrivedToSetPassword = /type=(invite|recovery)/.test(location.hash);

const state = {
  agencies: [] as Agency[],
  agency: null as Agency | null,
  profile: null as Profile | null,
  referrals: [] as Referral[],
  view: "queue" as View,
  channel: null as RealtimeChannel | null,
  loggedIds: "",
  needsPassword: arrivedToSetPassword,
};

const root = document.getElementById("root")!;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const isManager = () => state.agency?.role === "owner" || state.agency?.role === "admin";

const LOGO = `<svg class="mark" viewBox="0 0 120 120" role="img" aria-label="CIS Tech logo"><defs><linearGradient id="lb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1E6FD9"/><stop offset="1" stop-color="#0A2E6E"/></linearGradient><linearGradient id="ls" gradientUnits="userSpaceOnUse" x1="53" y1="0" x2="67" y2="0"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#D5DCE4"/><stop offset="1" stop-color="#9AA6B4"/></linearGradient></defs><rect x="4" y="4" width="112" height="112" rx="30" fill="url(#lb)"/><rect x="56" y="30" width="8" height="72" rx="4" fill="url(#ls)"/><circle cx="60" cy="22" r="7" fill="url(#ls)"/><circle cx="60" cy="22" r="2.8" fill="#0A2E6E"/><path d="M76 36 C52 30 42 45 60 51 C78 57 78 68 60 72 C42 76 42 88 60 92 C67 94 70 98 66 102" fill="none" stroke="#0E3A82" stroke-width="12" stroke-linecap="round"/><path d="M76 36 C52 30 42 45 60 51 C78 57 78 68 60 72 C42 76 42 88 60 92 C67 94 70 98 66 102" fill="none" stroke="url(#ls)" stroke-width="6.5" stroke-linecap="round"/><circle cx="77" cy="36.5" r="5" fill="url(#ls)"/><rect x="54" y="67.5" width="12" height="9" fill="#0E3A82"/><rect x="56" y="62" width="8" height="20" fill="url(#ls)"/></svg>`;

// ---------------------------------------------------------------------------
// Routing: sign in -> set password -> two-step verification -> agency -> app
// ---------------------------------------------------------------------------

let routing: Promise<void> | null = null;
function route(): Promise<void> {
  routing ??= doRoute().finally(() => (routing = null));
  return routing;
}

async function doRoute() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return renderSignIn();
  if (state.needsPassword) return renderSetPassword();

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") {
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const verified = factors?.totp.find((f) => f.status === "verified");
    return verified ? renderMfaChallenge(verified.id) : renderMfaEnroll();
  }

  const { data: rows, error } = await supabase
    .from("memberships")
    .select("role, agencies(id, name, provider_type)")
    .eq("user_id", session.user.id);
  if (error) return renderMessage("Couldn't load your account", error.message);
  state.agencies = (rows ?? []).flatMap((r) => {
    const a = r.agencies as unknown as { id: string; name: string; provider_type: string } | null;
    return a ? [{ ...a, role: r.role as Role }] : [];
  });
  if (!state.agencies.length) return renderCreateAgency();
  await openAgency(state.agencies[0]);
}

function authShell(title: string, body: string) {
  root.innerHTML = `<div class="auth"><div class="auth-card panel">
    <div class="brand">${LOGO}<div><b>CIS<span> TECH</span></b><small>Referral Desk</small></div></div>
    <h1>${esc(title)}</h1>${body}</div></div>`;
}

function renderMessage(title: string, text: string) {
  authShell(title, `<p class="muted">${esc(text)}</p><button class="btn" id="out">Sign out</button>`);
  $("#out").onclick = () => supabase.auth.signOut();
}

function renderSignIn(note = "") {
  authShell("Sign in", `
    ${note ? `<p class="status">${esc(note)}</p>` : ""}
    <form id="f" class="stack">
      <label class="field">Email<input id="email" type="email" autocomplete="username" required></label>
      <label class="field">Password<input id="password" type="password" autocomplete="current-password" required></label>
      <button class="btn primary">Sign in</button>
      <p class="status" id="st" aria-live="polite"></p>
    </form>
    <button class="link" id="forgot">Forgot your password?</button>`);
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await supabase.auth.signInWithPassword({
      email: $<HTMLInputElement>("#email").value.trim(),
      password: $<HTMLInputElement>("#password").value,
    });
    if (error) setStatus("#st", "That email and password don't match. Try again or reset your password.", true);
  };
  $("#forgot").onclick = async () => {
    const email = $<HTMLInputElement>("#email").value.trim();
    if (!email) return setStatus("#st", "Enter your email first, then select Forgot your password.", true);
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
    setStatus("#st", "If that email has an account, a reset link is on its way.");
  };
}

function renderSetPassword() {
  authShell("Choose a password", `
    <form id="f" class="stack">
      <p class="muted">At least 12 characters. Next you'll set up two-step verification.</p>
      <label class="field">New password<input id="pw" type="password" autocomplete="new-password" minlength="12" required></label>
      <button class="btn primary">Save password</button>
      <p class="status" id="st" aria-live="polite"></p>
    </form>`);
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await supabase.auth.updateUser({ password: $<HTMLInputElement>("#pw").value });
    if (error) return setStatus("#st", error.message, true);
    state.needsPassword = false;
    route();
  };
}

async function renderMfaEnroll() {
  // Clear any half-finished setup so a fresh QR code is shown.
  const { data: existing } = await supabase.auth.mfa.listFactors();
  for (const f of existing?.all ?? []) if (f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });

  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "Authenticator app" });
  if (error || !data) return renderMessage("Couldn't start two-step verification", error?.message ?? "Try again.");
  authShell("Set up two-step verification", `
    <p class="muted">CIS Tech holds patient information, so every account uses an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password or similar).</p>
    <ol class="steps-list"><li>Scan this code with the app.</li><li>Enter the 6-digit code it shows.</li></ol>
    <img class="qr" src="${esc(data.totp.qr_code)}" alt="QR code for your authenticator app">
    <p class="muted small">Can't scan? Enter this key: <code>${esc(data.totp.secret)}</code></p>
    ${codeForm()}`);
  bindCodeForm(data.id);
}

function renderMfaChallenge(factorId: string) {
  authShell("Enter your code", `<p class="muted">Open your authenticator app and enter the 6-digit code for CIS Tech.</p>${codeForm()}
    <button class="link" id="out">Sign out</button>`);
  bindCodeForm(factorId);
  $("#out").onclick = () => supabase.auth.signOut();
}

function codeForm() {
  return `<form id="code-f" class="stack">
    <label class="field">6-digit code<input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
    <button class="btn primary">Verify</button>
    <p class="status" id="st" aria-live="polite"></p></form>`;
}

function bindCodeForm(factorId: string) {
  $("#code-f").onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: $<HTMLInputElement>("#code").value.trim() });
    if (error) return setStatus("#st", "That code didn't work. Codes change every 30 seconds; try the current one.", true);
    route();
  };
}

function renderCreateAgency() {
  authShell("Set up your agency", `
    <form id="f" class="stack">
      <label class="field">Business name<input id="name" required maxlength="200"></label>
      <label class="field">Provider type<select id="type">${PROVIDER_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
      <button class="btn primary">Create agency</button>
      <p class="status" id="st" aria-live="polite"></p>
    </form>`);
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await supabase.rpc("create_agency", {
      p_name: $<HTMLInputElement>("#name").value.trim(),
      p_type: $<HTMLSelectElement>("#type").value,
    });
    if (error) return setStatus("#st", error.message, true);
    route();
  };
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

async function openAgency(agency: Agency) {
  state.agency = agency;
  renderShell();
  await Promise.all([loadProfile(), loadReferrals()]);
  state.channel?.unsubscribe();
  state.channel = supabase
    .channel(`referrals-${agency.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "referrals", filter: `agency_id=eq.${agency.id}` }, () => loadReferrals())
    .subscribe();
  setView(state.view);
}

async function loadProfile() {
  const { data } = await supabase.from("facility_profiles").select("*").eq("agency_id", state.agency!.id).maybeSingle();
  state.profile = data as Profile | null;
}

async function loadReferrals() {
  const { data, error } = await supabase
    .from("referrals")
    .select("id, received_at, source, source_contact, patient_initials, age, diagnosis, needs, payer, location, start_date, notes, status, recommendation, reply_text, responded_at")
    .eq("agency_id", state.agency!.id)
    .order("received_at", { ascending: false })
    .limit(300);
  if (error) return banner(`Couldn't load referrals: ${error.message}`);
  state.referrals = (data ?? []) as Referral[];
  if (state.view === "queue") renderQueue();
  updateOpenCount();
}

function renderShell() {
  const a = state.agency!;
  root.innerHTML = `
    <header class="top"><div class="wrap top-row">
      <div class="brand">${LOGO}<div><b>CIS<span> TECH</span></b><small>${esc(a.name)}</small></div></div>
      <nav class="tabs" role="tablist">
        <button class="tab" data-view="queue">Queue<span class="count" id="open-count" hidden>0</span></button>
        <button class="tab" data-view="new">New referral</button>
        <button class="tab" data-view="profile">Facility profile</button>
        <button class="tab" data-view="team">Team</button>
        ${isManager() ? `<button class="tab" data-view="activity">Activity log</button>` : ""}
      </nav>
      <button class="btn small" id="signout">Sign out</button>
    </div></header>
    <div class="banner" id="banner" hidden><div class="wrap" id="banner-text"></div></div>
    <main class="wrap" id="main"></main>`;
  root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => (b.onclick = () => setView(b.dataset.view as View)));
  $("#signout").onclick = () => supabase.auth.signOut();
}

function setView(v: View) {
  state.view = v;
  root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === v)));
  ({ queue: renderQueue, new: renderIntake, profile: renderProfile, team: renderTeam, activity: renderActivity })[v]();
}

function banner(text: string) {
  $("#banner-text").textContent = text;
  $("#banner").hidden = false;
}

function setStatus(sel: string, text: string, isError = false) {
  const el = $(sel);
  el.textContent = text;
  el.classList.toggle("err", isError);
}

// ----- Queue -----

function updateOpenCount() {
  const el = root.querySelector<HTMLElement>("#open-count");
  if (!el) return;
  const n = state.referrals.filter((r) => r.status === "open").length;
  el.textContent = String(n);
  el.hidden = !n;
}

function renderQueue() {
  const open = state.referrals.filter((r) => r.status === "open").sort((a, b) => a.received_at.localeCompare(b.received_at));
  const done = state.referrals.filter((r) => r.status !== "open");
  const times = done.filter((r) => r.responded_at).map((r) => Date.parse(r.responded_at!) - Date.parse(r.received_at)).sort((a, b) => a - b);
  const pct = times.length ? `${Math.round((100 * times.filter((t) => t <= SLA_MS).length) / times.length)}%` : "–";
  const median = times.length ? mmss(times[Math.floor((times.length - 1) / 2)]) : "–";

  $("#main").innerHTML = `
    <div class="stats">
      <div class="stat"><span>Waiting for an answer</span><b>${open.length}</b></div>
      <div class="stat"><span>Answered in 15 min</span><b>${pct}</b></div>
      <div class="stat"><span>Median response</span><b>${median}</b></div>
      <div class="stat"><span>Accepted</span><b>${done.filter((r) => r.status === "accepted").length}</b></div>
    </div>
    <div class="section-head"><h2>Referral queue</h2><button class="btn primary" id="go-new">+ New referral</button></div>
    <div class="list">${state.referrals.length
      ? [...open, ...done].map(cardHTML).join("")
      : `<div class="panel empty"><h3>No referrals yet</h3><p>Add a referral and it shows up here with a 15-minute clock and a recommendation.</p></div>`}</div>`;
  $("#go-new").onclick = () => setView("new");
  root.querySelectorAll<HTMLButtonElement>("[data-decide]").forEach((b) => (b.onclick = () => decide(b.dataset.id!, b.dataset.decide as "accepted" | "declined", b)));
  root.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => (b.onclick = () => copyReply(b)));
  tick();
  logViews();
}

function cardHTML(r: Referral) {
  const rec = r.status === "open" ? recommend(r, state.profile) : (r.recommendation ?? recommend(r, state.profile));
  const chip = { accept: ["accept", "Recommend accept"], review: ["review", "Needs review"], decline: ["decline", "Recommend decline"] }[rec.verdict];
  const right = r.status === "open"
    ? `<span class="chip ${chip[0]}">${chip[1]}</span>`
    : `<span class="chip ${r.status === "accepted" ? "accept" : "decline"}">${r.status === "accepted" ? "Accepted" : "Declined"}</span>`;
  const actions = r.status === "open"
    ? `<div class="actions"><button class="btn good small" data-decide="accepted" data-id="${esc(r.id)}">Accept</button>
       <button class="btn bad small" data-decide="declined" data-id="${esc(r.id)}">Decline</button></div>`
    : `<div class="reply"><div class="reply-head"><b>Reply to referral source</b><button class="btn small" data-copy="${esc(r.id)}">Copy</button></div>
       <p id="reply-${esc(r.id)}">${esc(r.reply_text)}</p></div>`;
  return `<article class="ref" data-ref="${esc(r.id)}">
    <div class="clockcol" data-clock="${esc(r.id)}"></div>
    <div class="body">
      <div class="ref-top"><div><h3>${esc(r.patient_initials || "Patient")}${r.age != null ? `, ${esc(r.age)}` : ""} · ${esc(r.diagnosis || "Diagnosis not given")}</h3>
        <p class="muted small">Received ${esc(new Date(r.received_at).toLocaleString())}</p></div>${right}</div>
      <div class="facts">
        <span>Source <b>${esc(r.source || "Unknown")}</b></span>
        ${r.source_contact ? `<span>Contact <b>${esc(r.source_contact)}</b></span>` : ""}
        <span>Payer <b>${esc(r.payer ? labelOf(PAYERS, r.payer) : "Unknown")}</b></span>
        <span>Location <b>${esc(r.location || "Unknown")}</b></span>
        ${r.start_date ? `<span>Start <b>${esc(formatDate(r.start_date))}</b></span>` : ""}
      </div>
      <div class="facts"><span>Needs <b>${esc(r.needs.map((n) => labelOf(SERVICES, n)).join(", ") || "None listed")}</b></span></div>
      ${r.notes ? `<p class="muted small">${esc(r.notes)}</p>` : ""}
      <ul class="reasons">${rec.reasons.map((x) => `<li class="${x.kind}">${esc(x.text)}</li>`).join("")}</ul>
      ${actions}
    </div></article>`;
}

function tick() {
  const now = Date.now();
  root.querySelectorAll<HTMLElement>("[data-clock]").forEach((el) => {
    const r = state.referrals.find((x) => x.id === el.dataset.clock);
    if (!r) return;
    const received = Date.parse(r.received_at);
    let t: string, sub: string, cls: string, pct: number;
    if (r.status === "open") {
      const elapsed = now - received, left = SLA_MS - elapsed;
      cls = left <= 0 ? "bad" : elapsed > 10 * 60 * 1000 ? "warn" : "ok";
      t = left > 0 ? mmss(left) : `+${mmss(-left)}`;
      sub = left > 0 ? "left to answer" : "overdue";
      pct = Math.min(100, (elapsed / SLA_MS) * 100);
      el.closest(".ref")!.classList.toggle("overdue", left <= 0);
    } else {
      const took = Date.parse(r.responded_at ?? r.received_at) - received;
      cls = took <= SLA_MS ? "ok" : "bad";
      t = mmss(took);
      sub = took <= SLA_MS ? "answered in time" : "answered late";
      pct = Math.min(100, (took / SLA_MS) * 100);
    }
    el.innerHTML = `<span class="t ${cls}">${t}</span><small>${sub}</small><div class="meter"><i class="${cls}" style="width:${pct}%"></i></div>`;
  });
}

function mmss(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function decide(id: string, status: "accepted" | "declined", btn: HTMLButtonElement) {
  const r = state.referrals.find((x) => x.id === id);
  if (!r || r.status !== "open") return;
  btn.disabled = true;
  const rec = recommend(r, state.profile);
  const { error } = await supabase
    .from("referrals")
    .update({ status, recommendation: rec, reply_text: replyText(r, status, rec, state.agency!.name) })
    .eq("id", id);
  if (error) {
    btn.disabled = false;
    return banner(`Couldn't save that decision: ${error.message}`);
  }
  await loadReferrals();
}

function copyReply(btn: HTMLButtonElement) {
  const el = $(`#reply-${btn.dataset.copy}`);
  navigator.clipboard.writeText(el.textContent ?? "").then(
    () => { btn.textContent = "Copied"; setTimeout(() => (btn.textContent = "Copy"), 1500); },
    () => { const range = document.createRange(); range.selectNodeContents(el); getSelection()?.removeAllRanges(); getSelection()?.addRange(range); },
  );
}

// Record which referrals were shown on screen (HIPAA access logging).
function logViews() {
  const ids = state.referrals.map((r) => r.id);
  const key = ids.join(",");
  if (!ids.length || key === state.loggedIds) return;
  state.loggedIds = key;
  supabase.rpc("log_access", { p_agency: state.agency!.id, p_record_ids: ids, p_context: "queue" });
}

// ----- New referral -----

function renderIntake() {
  $("#main").innerHTML = `
    <div class="intake">
      <div class="panel">
        <div><h2>Paste the referral</h2><p class="muted">Paste a fax, email or portal message. Claude pulls out the details and fills in the form.</p></div>
        <textarea id="raw" rows="14" maxlength="20000" placeholder="Paste referral text here"></textarea>
        <div class="actions"><button class="btn primary" id="extract">Read with Claude</button></div>
        <p class="status" id="ex-st" aria-live="polite"></p>
      </div>
      <form class="panel" id="ref-form" autocomplete="off">
        <h2>Referral details</h2>
        <div class="grid2">
          <label class="field">Referral source<input id="f-source" maxlength="300"></label>
          <label class="field">Contact<input id="f-contact" maxlength="300"></label>
        </div>
        <div class="grid3">
          <label class="field">Patient initials<input id="f-initials" maxlength="10" placeholder="R.M."></label>
          <label class="field">Age<input id="f-age" type="number" min="0" max="130"></label>
          <label class="field">Start of care<input id="f-start" type="date"></label>
        </div>
        <label class="field">Diagnosis<input id="f-dx" maxlength="1000"></label>
        <div class="grid2">
          <label class="field">Payer<select id="f-payer"><option value="">Unknown</option>${PAYERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
          <label class="field">Patient location<input id="f-location" maxlength="200" placeholder="County or city"></label>
        </div>
        <fieldset class="field"><legend>Care needs</legend><div class="checks">${SERVICES.map(([v, l]) => `<label><input type="checkbox" value="${v}" name="need">${l}</label>`).join("")}</div></fieldset>
        <label class="field">Notes<textarea id="f-notes" rows="2" maxlength="2000"></textarea></label>
        <div class="preview" id="preview"></div>
        <div class="actions"><button class="btn primary" id="add">Add to queue</button><span class="status" id="add-st" aria-live="polite"></span></div>
      </form>
    </div>`;
  $("#extract").onclick = extract;
  $("#ref-form").oninput = renderPreview;
  $("#ref-form").onsubmit = addReferral;
  renderPreview();
}

function readForm() {
  const v = (id: string) => $<HTMLInputElement>(id).value.trim();
  return {
    source: v("#f-source") || null,
    source_contact: v("#f-contact") || null,
    patient_initials: v("#f-initials") || null,
    age: v("#f-age") ? Number(v("#f-age")) : null,
    start_date: v("#f-start") || null,
    diagnosis: v("#f-dx") || null,
    payer: v("#f-payer") || null,
    location: v("#f-location") || null,
    notes: v("#f-notes") || null,
    needs: [...root.querySelectorAll<HTMLInputElement>('input[name="need"]:checked')].map((i) => i.value),
  };
}

function renderPreview() {
  const rec = recommend(readForm(), state.profile);
  const chip = { accept: ["accept", "Recommend accept"], review: ["review", "Needs review"], decline: ["decline", "Recommend decline"] }[rec.verdict];
  $("#preview").innerHTML = `<div class="actions"><h3>Recommendation</h3><span class="chip ${chip[0]}">${chip[1]}</span></div>
    <ul class="reasons">${rec.reasons.map((x) => `<li class="${x.kind}">${esc(x.text)}</li>`).join("")}</ul>`;
}

async function extract() {
  const text = $<HTMLTextAreaElement>("#raw").value.trim();
  if (!text) return setStatus("#ex-st", "Paste a referral first.", true);
  const btn = $<HTMLButtonElement>("#extract");
  btn.disabled = true;
  setStatus("#ex-st", "Claude is reading the referral...");
  const { data, error } = await supabase.functions.invoke("extract-referral", { body: { agencyId: state.agency!.id, text } });
  btn.disabled = false;
  if (error) {
    const msg = error instanceof FunctionsHttpError ? (await error.context.json().catch(() => ({}))).error : null;
    return setStatus("#ex-st", msg ?? "Claude couldn't read this referral. Fill in the form by hand.", true);
  }
  const f = data.fields;
  $<HTMLInputElement>("#f-source").value = f.source;
  $<HTMLInputElement>("#f-contact").value = f.sourceContact;
  $<HTMLInputElement>("#f-initials").value = f.patientInitials;
  $<HTMLInputElement>("#f-age").value = f.age ?? "";
  $<HTMLInputElement>("#f-start").value = f.startDate;
  $<HTMLInputElement>("#f-dx").value = f.diagnosis;
  $<HTMLSelectElement>("#f-payer").value = f.payer;
  $<HTMLInputElement>("#f-location").value = f.location;
  $<HTMLTextAreaElement>("#f-notes").value = f.notes;
  root.querySelectorAll<HTMLInputElement>('input[name="need"]').forEach((i) => (i.checked = f.needs.includes(i.value)));
  renderPreview();
  setStatus("#ex-st", "Done. Check the details, then add it to the queue.");
}

async function addReferral(e: Event) {
  e.preventDefault();
  const r = readForm();
  if (!r.patient_initials && !r.diagnosis) return setStatus("#add-st", "Add at least patient initials or a diagnosis.", true);
  const { error } = await supabase.from("referrals").insert({
    ...r,
    agency_id: state.agency!.id,
    raw_text: $<HTMLTextAreaElement>("#raw").value.slice(0, 20000) || null,
  });
  if (error) return setStatus("#add-st", `Couldn't add the referral: ${error.message}`, true);
  await loadReferrals();
  setView("queue");
}

// ----- Facility profile -----

function renderProfile() {
  const p = state.profile ?? { open_slots: 0, service_area: [], services: [], payers: [] };
  const a = state.agency!;
  const ro = isManager() ? "" : "disabled";
  $("#main").innerHTML = `
    <form class="panel" id="pf" autocomplete="off">
      <div><h2>Facility profile</h2><p class="muted">What your business can actually take on. Every referral is checked against this.${isManager() ? "" : " Only owners and admins can change it."}</p></div>
      <div class="grid3">
        <label class="field">Business name<input id="p-name" value="${esc(a.name)}" maxlength="200" ${ro}></label>
        <label class="field">Provider type<select id="p-type" ${ro}>${PROVIDER_TYPES.map(([v, l]) => `<option value="${v}" ${v === a.provider_type ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field">Open slots or beds right now<input id="p-slots" type="number" min="0" value="${p.open_slots}" ${ro}></label>
      </div>
      <label class="field">Service area (counties or cities, separated by commas)<input id="p-area" value="${esc(p.service_area.join(", "))}" ${ro}></label>
      <fieldset class="field"><legend>Services you provide</legend><div class="checks">${SERVICES.map(([v, l]) => `<label><input type="checkbox" name="svc" value="${v}" ${p.services.includes(v) ? "checked" : ""} ${ro}>${l}</label>`).join("")}</div></fieldset>
      <fieldset class="field"><legend>Payers you accept</legend><div class="checks">${PAYERS.map(([v, l]) => `<label><input type="checkbox" name="pay" value="${v}" ${p.payers.includes(v) ? "checked" : ""} ${ro}>${l}</label>`).join("")}</div></fieldset>
      ${isManager() ? `<div class="actions"><button class="btn primary">Save profile</button><span class="status" id="p-st" aria-live="polite"></span></div>` : ""}
    </form>`;
  $("#pf").onsubmit = saveProfile;
}

async function saveProfile(e: Event) {
  e.preventDefault();
  const a = state.agency!;
  const checked = (name: string) => [...root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((i) => i.value);
  const name = $<HTMLInputElement>("#p-name").value.trim();
  const type = $<HTMLSelectElement>("#p-type").value;
  const profile = {
    open_slots: Number($<HTMLInputElement>("#p-slots").value || 0),
    service_area: $<HTMLInputElement>("#p-area").value.split(",").map((s) => s.trim()).filter(Boolean),
    services: checked("svc"),
    payers: checked("pay"),
  };
  const [r1, r2] = await Promise.all([
    supabase.from("facility_profiles").update(profile).eq("agency_id", a.id),
    supabase.from("agencies").update({ name, provider_type: type }).eq("id", a.id),
  ]);
  const err = r1.error ?? r2.error;
  if (err) return setStatus("#p-st", `Couldn't save: ${err.message}`, true);
  state.profile = profile;
  Object.assign(a, { name, provider_type: type });
  setStatus("#p-st", "Saved. Open referrals are re-checked against the new profile.");
}

// ----- Team -----

async function renderTeam() {
  const { data } = await supabase.from("memberships").select("user_id, role, email, created_at").eq("agency_id", state.agency!.id).order("created_at");
  const { data: { user } } = await supabase.auth.getUser();
  $("#main").innerHTML = `
    <div class="panel">
      <h2>Team</h2>
      <div class="table-wrap"><table><thead><tr><th>Email</th><th>Role</th><th>Added</th></tr></thead><tbody>
        ${(data ?? []).map((m) => `<tr><td>${esc(m.email ?? "Unknown")}${m.user_id === user?.id ? " (you)" : ""}</td><td>${esc(m.role)}</td><td>${esc(new Date(m.created_at).toLocaleDateString())}</td></tr>`).join("")}
      </tbody></table></div>
      ${isManager() ? `
      <form id="inv" class="invite">
        <h3>Invite someone</h3>
        <div class="grid3">
          <label class="field">Email<input id="inv-email" type="email" required></label>
          <label class="field">Role<select id="inv-role"><option value="staff">Staff: works referrals</option><option value="admin">Admin: also edits profile and team</option></select></label>
          <div class="field end"><button class="btn primary">Send invite</button></div>
        </div>
        <p class="status" id="inv-st" aria-live="polite"></p>
      </form>` : ""}
    </div>`;
  if (!isManager()) return;
  $("#inv").onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await supabase.functions.invoke("invite-member", {
      body: { agencyId: state.agency!.id, email: $<HTMLInputElement>("#inv-email").value, role: $<HTMLSelectElement>("#inv-role").value },
    });
    if (error) {
      const msg = error instanceof FunctionsHttpError ? (await error.context.json().catch(() => ({}))).error : null;
      return setStatus("#inv-st", msg ?? "The invite couldn't be sent.", true);
    }
    renderTeam();
  };
}

// ----- Activity log (owners and admins) -----

async function renderActivity() {
  const [{ data: rows }, { data: members }] = await Promise.all([
    supabase.from("audit_log").select("at, actor, action, table_name, record_ids, fields").eq("agency_id", state.agency!.id).order("at", { ascending: false }).limit(200),
    supabase.from("memberships").select("user_id, email").eq("agency_id", state.agency!.id),
  ]);
  const who = new Map((members ?? []).map((m) => [m.user_id, m.email]));
  const what = (r: { action: string; table_name: string | null; record_ids: string[] | null; fields: string[] | null }) => {
    const n = r.record_ids?.length ?? 0;
    switch (r.action) {
      case "view": return `Viewed ${n} referral${n === 1 ? "" : "s"}`;
      case "ai_extract": return "Had Claude read a referral";
      case "insert": return `Added ${r.table_name === "referrals" ? "a referral" : (r.table_name ?? "").replace(/_/g, " ")}`;
      case "update": return `Changed ${(r.table_name ?? "").replace(/_/g, " ")}: ${(r.fields ?? []).filter((f) => f !== "updated_at").join(", ")}`;
      default: return `${r.action} ${r.table_name ?? ""}`;
    }
  };
  $("#main").innerHTML = `
    <div class="panel">
      <div><h2>Activity log</h2><p class="muted">Who viewed or changed patient information. It lists which fields changed, never their contents. Latest 200 entries.</p></div>
      <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>
        ${(rows ?? []).map((r) => `<tr><td class="mono">${esc(new Date(r.at).toLocaleString())}</td><td>${esc(who.get(r.actor) ?? "System")}</td><td>${esc(what(r))}</td></tr>`).join("")}
      </tbody></table></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Automatic sign-out after 15 minutes without activity
// ---------------------------------------------------------------------------

let idleTimer = 0;
function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    await supabase.auth.signOut();
    renderSignIn("You were signed out after 15 minutes without activity.");
  }, IDLE_MS);
}
for (const ev of ["pointerdown", "keydown", "scroll", "touchstart"]) addEventListener(ev, resetIdle, { passive: true });
resetIdle();

setInterval(() => { if (state.view === "queue") tick(); }, 1000);

supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") {
    state.channel?.unsubscribe();
    Object.assign(state, { agency: null, agencies: [], referrals: [], profile: null, loggedIds: "" });
    renderSignIn();
  } else if (event === "SIGNED_IN" && !state.agency) {
    setTimeout(route, 0); // supabase-js asks that its own calls wait until this callback returns
  } else if (event === "PASSWORD_RECOVERY") {
    state.needsPassword = true;
    renderSetPassword();
  }
});

route();
