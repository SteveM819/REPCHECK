/* ============================================================
   RepCheck — cloud sync adapter (Supabase)
   ============================================================

   WHAT THIS IS
   localStorage stays the app's primary store — load()/save() in
   index.html are UNCHANGED. This file adds a mirror: every save()
   also pushes to Supabase in the background, and on boot the app
   pulls anything from Supabase that isn't in localStorage yet
   (new device, reinstall, or a second device's writes).

   This is deliberate, not a shortcut: localStorage is already
   offline-first and battle-tested against ~1300 lines of screen
   code that read/write S directly. Replacing it outright would
   mean touching all of that code. Mirroring it means touching two
   lines in index.html, ever.

   INTEGRATION — the only two edits needed in index.html:

   1. Before the existing <script> block, add:
        <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
        <script src="repcheck-cloud-sync.js"></script>

   2. Inside the existing script, two one-line additions:
        a) End of save() (~line 307):
             function save(){
               localStorage.setItem(STORE_KEY, JSON.stringify(S));
               RepCheckCloud.enqueuePush(S);            // <-- add this
             }
        b) Right after the initial `render()` call at boot (bottom of
           file, before the service-worker registration block):
             RepCheckCloud.init().then(() => RepCheckCloud.hydrate(S, (merged) => {
               S = merged; save(); render();
             }));

   No other line changes. Every screen, action function, and the
   e1RM/stall/volume calculations run exactly as they do today.

   AUTH
   Single-user app, so this uses Supabase magic-link email — no
   password to manage. On first load with no session, a small
   full-screen overlay (styled to match Concept C) asks for an
   email address, sends a sign-in link, and gets out of the way
   once you're authenticated. Session persists across visits.

   SYNC MODEL
   - Push: full-array upsert per entity type, keyed by a client_id
     column that stores the app's own Date.now()-based IDs exactly
     as they are today (no ID scheme change, no risk to the sort
     tiebreaks the app relies on elsewhere).
   - Child records with no independent identity in the app's model
     (template slots, session entries/sets, skips) are replaced
     wholesale under their parent on every push — simplest correct
     approach at this data volume (tens of sets per session, not
     thousands).
   - Pull/merge: additive only. Items that exist remotely but not
     locally get added in; items that already exist locally are
     left alone. This is intentionally conservative — safe for the
     "one primary device" reality today, and doesn't silently
     overwrite same-device edits with stale remote data. Real
     multi-device conflict resolution is out of scope for now.
   ============================================================ */

(function () {
  "use strict";

  const SUPABASE_URL = "https://ofhdrtkirajycluhashn.supabase.co";
  const SUPABASE_KEY = "sb_publishable_qhXxfGEanBMbBXhU4Oq2bw_AZGiTASG";

  let client = null;
  let session = null;
  let pushTimer = null;
  let pushInFlight = false;
  let pendingS = null;
  let lastSyncedAt = null;
  let lastError = null;

  function getClient() {
    if (!client) client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return client;
  }

  // ------------------------------------------------------------
  // Auth
  // ------------------------------------------------------------

  function renderAuthGate() {
    if (document.getElementById("rc-auth-gate")) return;
    const div = document.createElement("div");
    div.id = "rc-auth-gate";
    div.style.cssText =
      "position:fixed;inset:0;z-index:9999;background:#0b0f10;color:#f2f3ee;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;";
    div.innerHTML =
      '<div style="width:100%;max-width:320px;">' +
      '<div style="display:flex;align-items:flex-end;gap:2px;height:22px;margin-bottom:18px;">' +
      '<span style="width:5px;height:40%;background:#c8ff4d;display:block;border-radius:1px 1px 0 0;"></span>' +
      '<span style="width:5px;height:65%;background:#c8ff4d;display:block;border-radius:1px 1px 0 0;"></span>' +
      '<span style="width:5px;height:100%;background:#c8ff4d;display:block;border-radius:1px 1px 0 0;"></span>' +
      '<span style="font-size:16px;font-weight:700;margin-left:8px;">REPCHECK</span>' +
      "</div>" +
      '<div style="font-size:13px;color:#9aa39c;margin-bottom:18px;line-height:1.5;">Sign in to sync your sessions to the cloud. Enter your email and we\'ll send a link — no password.</div>' +
      '<input id="rc-auth-email" type="email" placeholder="you@example.com" ' +
      'style="width:100%;height:44px;border-radius:10px;border:1px solid #2a3234;background:#12181a;color:#f2f3ee;padding:0 14px;font-size:14px;margin-bottom:10px;box-sizing:border-box;" />' +
      '<button id="rc-auth-send" style="width:100%;height:44px;border-radius:10px;border:none;background:#c8ff4d;color:#0d1406;font-weight:700;font-size:14px;">Send sign-in link</button>' +
      '<div id="rc-auth-status" style="font-size:12px;color:#7c837b;margin-top:12px;min-height:16px;"></div>' +
      '<button id="rc-auth-skip" style="width:100%;margin-top:18px;background:none;border:none;color:#5a6058;font-size:11px;">Continue offline for now</button>' +
      "</div>";
    document.body.appendChild(div);

    document.getElementById("rc-auth-send").onclick = async () => {
      const email = document.getElementById("rc-auth-email").value.trim();
      const status = document.getElementById("rc-auth-status");
      if (!email) { status.textContent = "Enter an email address."; return; }
      status.textContent = "Sending…";
      const { error } = await getClient().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.href },
      });
      status.textContent = error ? "Couldn't send that — try again." : "Check your email for the link.";
    };
    document.getElementById("rc-auth-skip").onclick = () => hideAuthGate();
  }

  function hideAuthGate() {
    const el = document.getElementById("rc-auth-gate");
    if (el) el.remove();
  }

  // ------------------------------------------------------------
  // Public: init — restores session, listens for auth changes
  // ------------------------------------------------------------

  async function init() {
    const c = getClient();
    const { data } = await c.auth.getSession();
    session = data.session;
    if (!session) renderAuthGate();

    c.auth.onAuthStateChange((_event, sess) => {
      session = sess;
      if (session) {
        hideAuthGate();
        if (pendingS) enqueuePush(pendingS); // flush anything queued while signed out
      } else {
        renderAuthGate();
      }
    });

    window.addEventListener("online", () => { if (pendingS) schedulePush(200); });

    return session;
  }

  // ------------------------------------------------------------
  // Field mapping: S (app shape) <-> Supabase rows
  // ------------------------------------------------------------

  function exerciseToRow(userId, x) {
    return { user_id: userId, client_id: x.id, name: x.name, muscle_group: x.muscleGroup || null,
             is_compound: !!x.isCompound, note: x.note || null };
  }
  function rowToExercise(r) {
    return { id: r.client_id, name: r.name, muscleGroup: r.muscle_group, isCompound: r.is_compound, note: r.note };
  }

  function templateToRow(userId, t) {
    return { user_id: userId, client_id: t.id, name: t.name };
  }
  function rowToTemplate(r, slots) {
    return { id: r.client_id, name: r.name, slots };
  }

  function sessionToRow(userId, s, templateUuid) {
    // caller sets .status afterward (completed vs draft) — not this function's concern
    return {
      user_id: userId, client_id: s.id, session_date: s.date, template_id: templateUuid || null,
      name: s.name || null, notes: s.notes || null, duration_min: s.durationMin ?? null,
      rating: s.rating ?? null, flag: s.flag || null,
    };
  }

  function cardioToRow(userId, c) {
    return { user_id: userId, client_id: c.id, activity_date: c.date, activity_type: c.type,
             distance_km: c.km ?? null, duration_min: c.minutes ?? null, source: "manual" };
  }
  function rowToCardio(r) {
    return { id: r.client_id, date: r.activity_date, type: r.activity_type, km: r.distance_km, minutes: r.duration_min };
  }

  function blockToRow(userId, b) {
    return { user_id: userId, client_id: b.id, block_type: b.type, start_date: b.startDate,
             weeks: b.weeks, ended_at: b.endedAt || null };
  }
  function rowToBlock(r) {
    return { id: r.client_id, type: r.block_type, startDate: r.start_date, weeks: r.weeks, endedAt: r.ended_at };
  }

  function dailyMetricToRow(userId, d) {
    return { user_id: userId, metric_date: d.date, body_weight_kg: d.bodyweightKg ?? null,
             sleep_hours: d.sleepHours ?? null, notes: d.notes || null };
  }
  function rowToDailyMetric(r) {
    return { date: r.metric_date, bodyweightKg: r.body_weight_kg, sleepHours: r.sleep_hours, notes: r.notes };
  }

  function profileToRow(userId, settings) {
    return { id: userId, units: settings.units, weekly_run_target_km: settings.weeklyRunTargetKm,
             rest_default_sec: settings.restDefaultSec, keep_awake: settings.keepAwake,
             last_export_at: settings.lastExportAt || null, app_version: settings.appVersion || null };
  }

  // ------------------------------------------------------------
  // Push (S -> Supabase), full-replace for child collections
  // ------------------------------------------------------------

  async function pushNow(S) {
    const c = getClient();
    if (!session) return;
    const userId = session.user.id;

    // 1. Exercises — need uuids back for FK resolution below
    const exRows = (S.exercises || []).map((x) => exerciseToRow(userId, x));
    let exMap = {};
    if (exRows.length) {
      const { data, error } = await c.from("exercises").upsert(exRows, { onConflict: "user_id,client_id" }).select("id,client_id");
      if (error) throw error;
      data.forEach((r) => (exMap[r.client_id] = r.id));
    }

    // 2. Templates + slots
    const tplRows = (S.templates || []).map((t) => templateToRow(userId, t));
    let tplMap = {};
    if (tplRows.length) {
      const { data, error } = await c.from("templates").upsert(tplRows, { onConflict: "user_id,client_id" }).select("id,client_id");
      if (error) throw error;
      data.forEach((r) => (tplMap[r.client_id] = r.id));

      for (const t of S.templates) {
        const tplUuid = tplMap[t.id];
        await c.from("template_exercises").delete().eq("template_id", tplUuid);
        const slotRows = (t.slots || [])
          .filter((sl) => exMap[sl.exerciseId])
          .map((sl, idx) => ({
            template_id: tplUuid, exercise_id: exMap[sl.exerciseId], order_index: idx,
            target_sets: sl.targetSets || 3, target_rep_range: sl.targetRepRange || null, ss: sl.ss || null,
          }));
        if (slotRows.length) {
          const { error: slotErr } = await c.from("template_exercises").insert(slotRows);
          if (slotErr) throw slotErr;
        }
      }
    }

    // 3. Sessions (+ draft, if present) and their exercises/sets/skips
    const allSessions = (S.sessions || []).slice();
    if (S.draft) allSessions.push(Object.assign({}, S.draft, { __isDraft: true }));

    if (allSessions.length) {
      const sessRows = allSessions.map((s) => {
        const row = sessionToRow(userId, s, s.templateId ? tplMap[s.templateId] : null);
        row.status = s.__isDraft ? "draft" : "completed";
        return row;
      });
      const { data, error } = await c.from("sessions").upsert(sessRows, { onConflict: "user_id,client_id" }).select("id,client_id");
      if (error) throw error;
      const sessMap = {};
      data.forEach((r) => (sessMap[r.client_id] = r.id));

      for (const s of allSessions) {
        const sessUuid = sessMap[s.id];

        // skips
        await c.from("session_skips").delete().eq("session_id", sessUuid);
        const skipRows = (s.skips || [])
          .filter((sk) => exMap[sk.exerciseId])
          .map((sk) => ({
            session_id: sessUuid, exercise_id: exMap[sk.exerciseId], reason: sk.reason || null,
            swapped_to_exercise_id: sk.swappedToId ? exMap[sk.swappedToId] || null : null,
          }));
        if (skipRows.length) await c.from("session_skips").insert(skipRows);

        // entries -> session_exercises, then their sets
        await c.from("session_exercises").delete().eq("session_id", sessUuid);
        const entries = (s.entries || []).filter((e) => exMap[e.exerciseId]);
        if (entries.length) {
          const entryRows = entries.map((e, idx) => ({
            session_id: sessUuid, exercise_id: exMap[e.exerciseId], ss: e.ss || null, order_index: idx,
          }));
          const { data: entryData, error: entryErr } = await c
            .from("session_exercises").insert(entryRows).select("id,order_index");
          if (entryErr) throw entryErr;

          for (const entryRow of entryData) {
            const entry = entries[entryRow.order_index];
            const setRows = (entry.sets || []).map((set, idx) => ({
              session_exercise_id: entryRow.id, set_number: idx + 1, weight_kg: set.weightKg,
              reps: set.reps, effort: set.effort ?? null, is_warmup: !!set.isWarmup,
              is_done: set.done !== undefined ? !!set.done : true,
            }));
            if (setRows.length) {
              const { error: setErr } = await c.from("session_sets").insert(setRows);
              if (setErr) throw setErr;
            }
          }
        }
      }
    }

    // 4. Cardio, blocks, daily metrics, profile settings
    const cardioRows = (S.cardio || []).map((x) => cardioToRow(userId, x));
    if (cardioRows.length) {
      const { error } = await c.from("cardio_sessions").upsert(cardioRows, { onConflict: "user_id,client_id" });
      if (error) throw error;
    }
    const blockRows = (S.blocks || []).map((x) => blockToRow(userId, x));
    if (blockRows.length) {
      const { error } = await c.from("training_blocks").upsert(blockRows, { onConflict: "user_id,client_id" });
      if (error) throw error;
    }
    const dmRows = (S.dailyMetrics || []).map((x) => dailyMetricToRow(userId, x));
    if (dmRows.length) {
      const { error } = await c.from("daily_metrics").upsert(dmRows, { onConflict: "user_id,metric_date" });
      if (error) throw error;
    }
    if (S.settings) {
      const { error } = await c.from("profiles").upsert(profileToRow(userId, S.settings), { onConflict: "id" });
      if (error) throw error;
    }

    lastSyncedAt = new Date().toISOString();
    lastError = null;
  }

  function schedulePush(delay) {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(runPush, delay ?? 1500);
  }

  async function runPush() {
    if (pushInFlight || !pendingS || !session) return;
    pushInFlight = true;
    const S = pendingS;
    try {
      await pushNow(S);
      pendingS = null;
    } catch (e) {
      lastError = String((e && e.message) || e);
      console.warn("RepCheckCloud push failed, will retry when online:", lastError);
    } finally {
      pushInFlight = false;
    }
  }

  function enqueuePush(S) {
    pendingS = S;
    if (!session) return; // queued locally, flushed on sign-in
    schedulePush();
  }

  // ------------------------------------------------------------
  // Pull + additive merge (Supabase -> S), called once at boot
  // ------------------------------------------------------------

  async function pullAll() {
    const c = getClient();
    if (!session) return null;
    const userId = session.user.id;

    // Top-level tables first — plain eq() filters, no embedded-resource
    // filtering, so this doesn't depend on how deep PostgREST's nested
    // dot-path filters go.
    const [ex, tpl, sess, cardio, blocks, dm, profile] = await Promise.all([
      c.from("exercises").select("*").eq("user_id", userId),
      c.from("templates").select("*").eq("user_id", userId),
      c.from("sessions").select("*").eq("user_id", userId),
      c.from("cardio_sessions").select("*").eq("user_id", userId),
      c.from("training_blocks").select("*").eq("user_id", userId),
      c.from("daily_metrics").select("*").eq("user_id", userId),
      c.from("profiles").select("*").eq("id", userId).maybeSingle(),
    ]);
    for (const r of [ex, tpl, sess, cardio, blocks, dm, profile]) {
      if (r.error) throw r.error;
    }

    // Children, fetched by explicit parent-id lists (.in()) rather than
    // nested embedded filters — one extra round trip, zero ambiguity.
    const templateIds = tpl.data.map((t) => t.id);
    const sessionIds = sess.data.map((s) => s.id);

    const [tplEx, sessEx, skips] = await Promise.all([
      templateIds.length ? c.from("template_exercises").select("*").in("template_id", templateIds) : Promise.resolve({ data: [] }),
      sessionIds.length ? c.from("session_exercises").select("*").in("session_id", sessionIds) : Promise.resolve({ data: [] }),
      sessionIds.length ? c.from("session_skips").select("*").in("session_id", sessionIds) : Promise.resolve({ data: [] }),
    ]);
    for (const r of [tplEx, sessEx, skips]) {
      if (r.error) throw r.error;
    }

    const sessionExerciseIds = sessEx.data.map((se) => se.id);
    const sessSets = sessionExerciseIds.length
      ? await c.from("session_sets").select("*").in("session_exercise_id", sessionExerciseIds)
      : { data: [] };
    if (sessSets.error) throw sessSets.error;

    const exByUuid = {};
    ex.data.forEach((r) => (exByUuid[r.id] = r));

    const templates = tpl.data.map((t) => {
      const slots = tplEx.data
        .filter((se) => se.template_id === t.id)
        .sort((a, b) => a.order_index - b.order_index)
        .map((se) => ({
          exerciseId: exByUuid[se.exercise_id] ? exByUuid[se.exercise_id].client_id : null,
          targetSets: se.target_sets, targetRepRange: se.target_rep_range, ss: se.ss,
        }))
        .filter((sl) => sl.exerciseId);
      return rowToTemplate(t, slots);
    });

    const tplByUuid = {};
    tpl.data.forEach((r) => (tplByUuid[r.id] = r.client_id));

    const sessions = sess.data
      .filter((s) => s.status === "completed")
      .map((s) => {
        const myExRows = sessEx.data.filter((se) => se.session_id === s.id).sort((a, b) => a.order_index - b.order_index);
        const entries = myExRows.map((se) => ({
          exerciseId: exByUuid[se.exercise_id] ? exByUuid[se.exercise_id].client_id : null,
          ss: se.ss,
          sets: sessSets.data
            .filter((st) => st.session_exercise_id === se.id)
            .sort((a, b) => a.set_number - b.set_number)
            .map((st) => ({ weightKg: Number(st.weight_kg), reps: st.reps, effort: st.effort, isWarmup: st.is_warmup })),
        })).filter((e) => e.exerciseId);
        const mySkips = skips.data.filter((sk) => sk.session_id === s.id).map((sk) => ({
          exerciseId: exByUuid[sk.exercise_id] ? exByUuid[sk.exercise_id].client_id : null,
          reason: sk.reason,
          swappedToId: sk.swapped_to_exercise_id && exByUuid[sk.swapped_to_exercise_id] ? exByUuid[sk.swapped_to_exercise_id].client_id : null,
        })).filter((sk) => sk.exerciseId);
        return {
          id: s.client_id, date: s.session_date, templateId: s.template_id ? tplByUuid[s.template_id] : null,
          name: s.name, notes: s.notes, durationMin: s.duration_min, rating: s.rating, flag: s.flag,
          skips: mySkips, entries,
        };
      });

    return {
      exercises: ex.data.map(rowToExercise),
      templates,
      sessions,
      cardio: cardio.data.map(rowToCardio),
      blocks: blocks.data.map(rowToBlock),
      dailyMetrics: dm.data.map(rowToDailyMetric),
      settingsFromProfile: profile.data,
    };
  }

  function mergeAdditive(local, remote) {
    if (!remote) return local;
    const S = JSON.parse(JSON.stringify(local));
    const byId = (arr) => new Set((arr || []).map((x) => x.id));

    const localExIds = byId(S.exercises);
    (remote.exercises || []).forEach((r) => { if (!localExIds.has(r.id)) S.exercises.push(r); });

    const localTplIds = byId(S.templates);
    (remote.templates || []).forEach((r) => { if (!localTplIds.has(r.id)) S.templates.push(r); });

    const localSessIds = byId(S.sessions);
    (remote.sessions || []).forEach((r) => { if (!localSessIds.has(r.id)) S.sessions.push(r); });

    const localCardioIds = byId(S.cardio);
    (remote.cardio || []).forEach((r) => { if (!localCardioIds.has(r.id)) S.cardio.push(r); });

    const localBlockIds = byId(S.blocks);
    (remote.blocks || []).forEach((r) => { if (!localBlockIds.has(r.id)) S.blocks.push(r); });

    const localDates = new Set((S.dailyMetrics || []).map((d) => d.date));
    (remote.dailyMetrics || []).forEach((r) => { if (!localDates.has(r.date)) S.dailyMetrics.push(r); });

    return S;
  }

  async function hydrate(localS, onMerged) {
    if (!session) return;
    try {
      const remote = await pullAll();
      const merged = mergeAdditive(localS, remote);
      if (JSON.stringify(merged) !== JSON.stringify(localS)) onMerged(merged);
      lastSyncedAt = new Date().toISOString();
    } catch (e) {
      lastError = String((e && e.message) || e);
      console.warn("RepCheckCloud hydrate failed:", lastError);
    }
  }

  function getStatus() {
    return {
      connected: !!session,
      email: session ? session.user.email : null,
      lastSyncedAt,
      pending: !!pendingS,
      error: lastError,
    };
  }

  window.RepCheckCloud = { init, enqueuePush, hydrate, getStatus, signOut: () => getClient().auth.signOut() };
})();
