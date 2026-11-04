// @ts-nocheck
// NeuroResilience Consulting Inc. — partner photo upload (Supabase Edge Function: "hub-photo")
// © 2026 NeuroResilience Consulting Inc. All rights reserved.
//
// A partner's page sends one photo here, together with their private key (header "x-hub-key").
// This function:
//   1. checks the key with the database (the hub must be active, its permission current, and under today's photo limit)
//   2. accepts only a real JPEG up to 4 MB and 200 to 4096 pixels on each side (the page always converts photos to JPEG first)
//   3. removes all hidden data from the file: GPS location, camera details, comments, thumbnails, and anything tacked on after the picture
//   4. stores it in your "feed" storage under a random, unguessable name: partners/<hub>/<32 random characters>.jpg
//   5. records it, so it can be attached to ONE post from that same hub within 24 hours
// Nothing here is secret: the service key comes from Supabase's own settings.

import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "feed";
const MAX_BYTES = 4 * 1024 * 1024;
const MIN_SIDE = 200, MAX_SIDE = 4096;
const ALLOWED_ORIGINS = ["https://app.neuroresilienceconsulting.com", "https://hrconsultation22-beep.github.io"];

const env = (k, d = "") => Deno.env.get(k) || d;
function corsHeaders(origin) {
  const h = { "Vary": "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, x-hub-key, apikey, authorization, x-client-info", "Access-Control-Max-Age": "600" };
  if (origin && ALLOWED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const reply = (status, obj, cors) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors } });
const STATUS = { bad_key: 401, not_allowed: 403, photo_limit: 429, bad_type: 415, too_big: 413, bad_image: 422, bad_path: 500, server_error: 500 };

// ---------- reading the body, but never more than the limit ----------
async function readCapped(req, max) {
  if (Number(req.headers.get("content-length") || 0) > max) return "too_big";
  const reader = req.body && req.body.getReader();
  if (!reader) return new Uint8Array(0);
  const parts = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { try { await reader.cancel(); } catch (e) {} return "too_big"; }
    parts.push(value);
  }
  const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- checking a JPEG and removing everything hidden in it ----------
// Keeps only what is needed to draw the picture (and its colour profile). Removes: EXIF and XMP (APP1, where GPS lives),
// Photoshop/IPTC data (APP13), other application blocks, comments, and any bytes after the end of the picture.
function cleanJpeg(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  const chunks = [Uint8Array.of(0xFF, 0xD8)];
  let i = 2, width = 0, height = 0, sawFrame = false;
  while (i < b.length) {
    if (b[i] !== 0xFF) return null;
    while (i < b.length && b[i] === 0xFF) i++;                 // padding bytes
    if (i >= b.length) return null;
    const m = b[i++];
    if (m === 0xD9) return null;                                // end of picture before any picture data
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { chunks.push(Uint8Array.of(0xFF, m)); continue; }
    if (i + 2 > b.length) return null;
    const len = (b[i] << 8) | b[i + 1];
    if (len < 2 || i + len > b.length) return null;
    const end = i + len;
    if (m === 0xDA) {                                           // start of the picture data
      if (!sawFrame) return null;
      let k = end, eoi = -1;                                    // the first FF D9 after this point is the true end (inside picture data FF is always escaped)
      while (k + 1 < b.length) { if (b[k] === 0xFF && b[k + 1] === 0xD9) { eoi = k; break; } k++; }
      if (eoi < 0) return null;                                 // truncated file
      chunks.push(Uint8Array.of(0xFF, 0xDA)); chunks.push(b.subarray(i, eoi + 2));
      if (width < MIN_SIDE || height < MIN_SIDE || width > MAX_SIDE || height > MAX_SIDE) return null;
      let total = 0; for (const c of chunks) total += c.length;
      const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
      return { bytes: out, width, height };
    }
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {   // frame header: picture size
      if (len < 8) return null;
      height = (b[i + 3] << 8) | b[i + 4]; width = (b[i + 5] << 8) | b[i + 6]; sawFrame = true;
    }
    const strip = m === 0xE1 || (m >= 0xE3 && m <= 0xED) || m === 0xEF || m === 0xFE;   // APP1, APP3..APP13, APP15, comments
    if (!strip) { chunks.push(Uint8Array.of(0xFF, m)); chunks.push(b.subarray(i, end)); }
    i = end;
  }
  return null;
}

const randomHex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");

async function handle(req) {
  const origin = req.headers.get("origin") || "";
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply(405, { ok: false, error: "method_not_allowed" }, cors);
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return reply(403, { ok: false, error: "origin_not_allowed" }, {});

  const key = (req.headers.get("x-hub-key") || "").trim();
  if (!/^hk_[0-9a-f]{40}$/.test(key)) return reply(401, { ok: false, error: "bad_key" }, cors);

  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    // 1. may this key upload right now?
    const { data: gate, error: gErr } = await admin.rpc("hub_photo_gate", { p_key: key });
    if (gErr || !gate) { console.error("gate failed"); return reply(500, { ok: false, error: "server_error" }, cors); }
    if (!gate.ok) return reply(STATUS[gate.reason] || 403, { ok: false, error: gate.reason }, cors);

    // 2. what was sent
    if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("image/jpeg")) return reply(415, { ok: false, error: "bad_type" }, cors);
    const body = await readCapped(req, MAX_BYTES);
    if (body === "too_big") return reply(413, { ok: false, error: "too_big" }, cors);
    const clean = cleanJpeg(body);
    if (!clean) return reply(422, { ok: false, error: "bad_image" }, cors);

    // 3. store it under a random name, then record it
    const path = "partners/" + gate.slug + "/" + randomHex() + ".jpg";
    const { error: uErr } = await admin.storage.from(BUCKET).upload(path, clean.bytes, { contentType: "image/jpeg", upsert: false });
    if (uErr) { console.error("storage upload failed"); return reply(500, { ok: false, error: "server_error" }, cors); }
    const { data: rec, error: rErr } = await admin.rpc("hub_photo_record", { p_key: key, p_path: path });
    if (rErr || rec !== "ok") {
      try { await admin.storage.from(BUCKET).remove([path]); } catch (e) {}      // never leave a file nobody is tracking
      const why = rErr ? "server_error" : rec;
      return reply(STATUS[why] || 500, { ok: false, error: why }, cors);
    }
    return reply(200, { ok: true, path, remaining: Math.max(0, (gate.remaining || 1) - 1) }, cors);
  } catch (e) {
    console.error("hub-photo failed: " + (e && e.message));
    return reply(500, { ok: false, error: "server_error" }, cors);
  }
}

Deno.serve(handle);
