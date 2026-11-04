// @ts-nocheck
// NeuroResilience Consulting Inc. — Instagram to Axis Feed (Supabase Edge Function: "instagram-sync")
// © 2026 NeuroResilience Consulting Inc. All rights reserved.
//
// What it does, each time it runs (once a day):
//   1. Keeps your Instagram access token alive (refreshes it before the 60 days are up).
//   2. Reads your latest posts through Instagram's OFFICIAL API (your own professional account).
//   3. For each post it has not seen before: copies the picture into YOUR Supabase storage and saves
//      the post as a DRAFT in the feed, with a link back to the post on Instagram.
//   4. If you delete a post on Instagram, the matching feed post is switched off.
// Nothing is published until you publish it. Nothing here is secret: keys come from Supabase secrets.

import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "feed";
const MAX_POSTS = 25;                 // newest posts looked at per run
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const REFRESH_WHEN_DAYS_LEFT = 20;
const RECHECK_DAYS = 90;              // how far back we look for posts you deleted on Instagram
const MAX_REMOVAL_CHECKS = 20;
// Pictures are only ever fetched from Instagram's own image servers. (IG_IMAGE_HOSTS and IG_ALLOW_INSECURE_IMAGES exist only for testing and are left unset.)
const DEFAULT_IMAGE_HOSTS = ["cdninstagram.com", "fbcdn.net"];

const env = (k, d = "") => Deno.env.get(k) || d;
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- talking to Instagram ----------
class IgError extends Error {
  constructor(status, body) { super("instagram_" + status); this.status = status; this.code = body && body.error && body.error.code; this.subcode = body && body.error && body.error.error_subcode; }
  get tokenProblem() { return this.code === 190 || this.code === 10 || this.status === 401; }
  get gone() { return this.code === 100 || this.status === 404 || this.subcode === 33; }
}
async function igGet(path, params) {
  const url = new URL(env("IG_API_BASE", "https://graph.instagram.com") + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let r;
  try { r = await fetch(url.toString()); } catch (e) { throw new IgError(0, null); }
  let body = null; try { body = await r.json(); } catch (e) {}
  if (!r.ok || (body && body.error)) throw new IgError(r.status || 400, body);
  return body;
}
const ver = () => "/" + env("IG_API_VERSION", "v26.0");

// ---------- turning a caption into a feed post ----------
const TAGS = {
  fitness: ["fitness", "training", "strength", "workout", "gym", "exercise", "movement", "lifting"],
  recipes: ["recipe", "recipes", "axisrecipe"],
  meals: ["meal", "meals", "mealprep", "macros", "axismeal"],
  local: ["local", "axislocal", "shoplocal", "buylocal"],
  food: ["food", "nutrition", "eating", "protein", "diet"],
  mind: ["mind", "mentalhealth", "mentalwellness", "mindfulness", "sleep", "rest", "recovery", "breathwork", "stress", "wellbeing"],
};
function categoryFor(tags) {
  for (const t of tags) for (const [cat, list] of Object.entries(TAGS)) if (list.includes(t)) return cat;
  const d = env("IG_DEFAULT_CATEGORY", "fitness"); return TAGS[d] ? d : "fitness";
}
function cut(s, max) {
  if (s.length <= max) return s;
  const c = s.slice(0, max - 1); const i = c.lastIndexOf(" ");
  return (i > max * 0.6 ? c.slice(0, i) : c).replace(/[\s,.;:!-]+$/, "") + "\u2026";
}
function derive(caption) {
  let t = String(caption || "").replace(/\r/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  t = t.replace(/https?:\/\/\S+/g, "");
  const tags = [...t.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1].toLowerCase());
  t = t.replace(/#[\p{L}\p{N}_]+/gu, "");
  const lines = t.split(/\n+/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  let title = lines[0] || "", rest = lines.slice(1).join(" ");
  if (!rest) {                                   // one-line caption: use its first sentence as the title when there is more after it
    const m = title.match(/^(.{15,90}?[.!?])\s+(.+)$/s);
    if (m) { title = m[1]; rest = m[2]; }
  }
  if (title.length > 90) { rest = (title + " " + rest).trim(); title = cut(title, 90); }
  if (title.length < 3) title = "From our Instagram";
  let body = cut(rest.trim(), 600);
  if (body.length < 10) body = "See the full post on Instagram.";
  return { title, body, tags };
}
const imageHosts = () => (env("IG_IMAGE_HOSTS") ? env("IG_IMAGE_HOSTS").split(",").map((h) => h.trim()).filter(Boolean) : DEFAULT_IMAGE_HOSTS);
const allowedHost = (u) => {
  try {
    const x = new URL(u);
    const okProtocol = x.protocol === "https:" || (env("IG_ALLOW_INSECURE_IMAGES") === "true" && x.protocol === "http:");
    return okProtocol && imageHosts().some((h) => x.hostname === h || x.hostname.endsWith("." + h));
  } catch (e) { return false; }
};
const imageUrlFor = (m) => (m.media_type === "VIDEO" ? m.thumbnail_url : (m.media_url || m.thumbnail_url)) || "";
const permalinkOk = (u) => /^https:\/\/(www\.)?instagram\.com\/[^\s]{2,200}$/.test(u || "");

async function fetchImage(url) {
  if (!allowedHost(url)) return null;
  let r; try { r = await fetch(url); } catch (e) { return null; }
  if (!r.ok) return null;
  const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[type];
  if (!ext) return null;
  if (Number(r.headers.get("content-length") || 0) > MAX_IMAGE_BYTES) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  return { bytes, type, ext };
}

// ---------- the run ----------
// mode "quick" (hourly): only looks for new posts. mode "full" (daily): also renews the token and switches off posts you deleted on Instagram.
async function run(admin, mode = "full") {
  const out = { ok: true, mode, imported: 0, already_have: 0, skipped: 0, image_failed: 0, removed: 0, refreshed: false };
  const rpc = async (name, args) => { const { data, error } = await admin.rpc(name, args || {}); if (error) throw new Error("db_" + name); return data; };

  const conn = (await rpc("ig_connection_get"))[0];
  if (!conn || !conn.access_token) return { status: 409, body: { ok: false, error: "not_connected" } };
  let token = conn.access_token, username = conn.username || "", userId = conn.ig_user_id || "";

  // 1. keep the token alive
  const left = conn.expires_at ? (new Date(conn.expires_at).getTime() - Date.now()) / 86400000 : 0;
  if (mode === "full" && left < REFRESH_WHEN_DAYS_LEFT) {
    try {
      const r = await igGet("/refresh_access_token", { grant_type: "ig_refresh_token", access_token: token });
      if (r && r.access_token) {
        token = r.access_token; out.refreshed = true;
        await rpc("ig_connection_save", { p_token: token, p_expires: new Date(Date.now() + (Number(r.expires_in) || 5184000) * 1000).toISOString(), p_user_id: null, p_username: null });
      }
    } catch (e) { if (left <= 0) { await rpc("ig_connection_status", { p_error: "The Instagram token has expired. Generate a new one in the Meta dashboard and paste it in again." }); return { status: 502, body: { ok: false, error: "token_expired" } }; } }
  }

  try {
    if (!username || !userId) {
      const me = await igGet(ver() + "/me", { fields: "user_id,username", access_token: token });
      username = String(me.username || ""); userId = String(me.user_id || me.id || "");
      await rpc("ig_connection_save", { p_token: null, p_expires: null, p_user_id: userId || null, p_username: username || null });
    }
    // 2. the latest posts
    const list = await igGet(ver() + "/me/media", { fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp", limit: MAX_POSTS, access_token: token });
    const media = Array.isArray(list && list.data) ? list.data.slice(0, MAX_POSTS) : [];
    const known = await rpc("ig_known", { p_days: RECHECK_DAYS });
    const have = new Set(known.map((k) => k.ig_media_id));
    const requireTag = env("IG_REQUIRE_TAG").replace(/^#/, "").toLowerCase();
    const publish = env("IG_AUTO_PUBLISH") === "true";

    // 3. new posts become drafts
    for (const m of media) {
      if (!m || typeof m.id !== "string" || !/^[0-9]{5,30}$/.test(m.id)) { out.skipped++; continue; }
      if (have.has(m.id)) { out.already_have++; continue; }
      const { title, body, tags } = derive(m.caption);
      if (requireTag && !tags.includes(requireTag)) { out.skipped++; continue; }
      let imagePath = null;
      const src = imageUrlFor(m);
      if (src) {
        const img = await fetchImage(src);
        if (!img) { out.image_failed++; continue; }            // try again on the next run
        const path = "ig/" + m.id + "." + img.ext;
        const { error } = await admin.storage.from(BUCKET).upload(path, img.bytes, { contentType: img.type, upsert: true });
        if (error) { out.image_failed++; continue; }
        imagePath = path;
      }
      const created = await rpc("ig_record_post", {
        p_media: m.id, p_category: categoryFor(tags), p_title: title, p_body: body, p_image: imagePath,
        p_link: permalinkOk(m.permalink) ? m.permalink : null, p_note: username ? "From @" + username.slice(0, 40) + " on Instagram" : "From our Instagram",
        p_publish: publish, p_created: m.timestamp && !isNaN(Date.parse(m.timestamp)) ? new Date(m.timestamp).toISOString() : null,
      });
      if (created) out.imported++; else out.already_have++;
    }

    // 4. posts you deleted on Instagram
    const seen = new Set(media.map((m) => m && m.id));
    const check = mode === "full" ? known.filter((k) => k.recent && !k.removed && !seen.has(k.ig_media_id)).slice(0, MAX_REMOVAL_CHECKS) : [];
    for (const k of check) {
      try { await igGet(ver() + "/" + k.ig_media_id, { fields: "id", access_token: token }); }
      catch (e) { if (e instanceof IgError && e.gone) { await rpc("ig_mark_removed", { p_media: k.ig_media_id }); out.removed++; } }
    }
    await rpc("ig_connection_status", { p_error: null });
    return { status: 200, body: out };
  } catch (e) {
    if (e instanceof IgError) {
      const msg = e.tokenProblem ? "Instagram rejected the access token. Generate a new one in the Meta dashboard and paste it in again." : "Instagram could not be reached or returned an error (" + e.status + ").";
      await rpc("ig_connection_status", { p_error: msg });
      return { status: 502, body: { ok: false, error: e.tokenProblem ? "token_invalid" : "instagram_error" } };
    }
    throw e;
  }
}

async function handle(req) {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const secret = env("SYNC_SECRET");
  if (!secret) return json(500, { error: "not_configured" });
  const given = req.headers.get("x-sync-secret") || "";
  if (!given || !safeEqual(given, secret)) return json(401, { error: "unauthorized" });
  try {
    const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
    const mode = (req.headers.get("x-sync-mode") || "").toLowerCase() === "quick" ? "quick" : "full";   // anything else means a full run
    const r = await run(admin, mode);
    return json(r.status, r.body);
  } catch (e) {
    console.error("instagram-sync failed: " + (e && e.message));
    return json(500, { ok: false, error: "server_error" });
  }
}

Deno.serve(handle);
