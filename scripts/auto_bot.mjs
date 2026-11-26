#!/usr/bin/env node
/**
 * OBSIDIAN DIAMOND V18.5 — Autonomous Daily Scanner, Auto-Settle, 5W1H Learner & Telegram Bot
 * Runs on GitHub Actions (Node 22, zero external dependencies).
 * Reads secrets ONLY from environment variables:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, API_FOOTBALL_KEY (optional)
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const MEMORY_PATH = path.join(DATA_DIR, "memory.json");
const PICKS_PATH = path.join(DATA_DIR, "daily_picks.json");
const NEWS_PATH = path.join(DATA_DIR, "news_intel.json");
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://enginebola.web.id/";

const TZ_AMT = "Asia/Yerevan";
const TZ_WIB = "Asia/Jakarta";

function fmtTime(d, tz) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}
function fmtDate(d, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function fmtKickoffDual(utcStr) {
  if (!utcStr) return "--:--";
  const d = new Date(utcStr);
  if (Number.isNaN(d.getTime())) return "--:--";
  const amt = fmtTime(d, TZ_AMT);
  const wib = fmtTime(d, TZ_WIB);
  const plus = fmtDate(d, TZ_WIB) !== fmtDate(d, TZ_AMT) ? " (+1)" : "";
  return `${amt} AMT / ${wib} WIB${plus}`;
}
function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function classifyHeadline(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(injured|injury|ruled out|hamstring|acl|knee|ankle|sidelined|fitness doubt|miss clash|blow)\b/.test(t)) return "INJURY_SHOCK";
  if (/\b(suspended|suspension|banned|red card|ban)\b/.test(t)) return "SUSPENSION_BAN";
  if (/\b(sacked|fired|crisis|dressing room|unrest|interim|new manager|boycott|strike)\b/.test(t)) return "MANAGER_CRISIS";
  if (/\b(rotate|rotation|rested|fringe players|second-string|youth squad)\b/.test(t)) return "ROTATION_HINT";
  if (/\b(returns|back in training|fit again|injury boost|available again)\b/.test(t)) return "SQUAD_BOOST";
  return "TEAM_NEWS";
}

function cleanTeamForQuery(name) {
  return String(name || "")
    .replace(/\b(FC|CF|SC|SK|FK|AC|AS|SS|UD|CD|SL|SV|VfB|VfL|RB|TSG)\b/gi, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchNewsIntelForMatch(homeName, awayName, newsApiKey) {
  if (!newsApiKey) return null;
  const hClean = cleanTeamForQuery(homeName);
  const aClean = cleanTeamForQuery(awayName);
  if (!hClean || !aClean) return null;
  const fromIso = new Date(Date.now() - 72 * 3600 * 1000).toISOString().slice(0, 10);
  const q = `("${hClean}" OR "${aClean}") AND (football OR soccer OR Champions OR League) AND (injury OR injured OR lineup OR suspended OR manager OR rotation OR squad OR fitness OR returns)`;
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&from=${fromIso}&language=en&sortBy=publishedAt&pageSize=6`;
  try {
    const resp = await fetch(url, { headers: { "X-Api-Key": newsApiKey, "User-Agent": "ObsidianV18/1.0" } });
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json.status !== "ok" || !Array.isArray(json.articles)) return null;
    const hLow = hClean.toLowerCase();
    const aLow = aClean.toLowerCase();
    const headlines = [];
    const seen = new Set();
    for (const art of json.articles) {
      const title = (art.title || "").trim();
      const desc = (art.description || "").trim();
      if (!title || title === "[Removed]") continue;
      const titleLow = title.toLowerCase();
      if (!titleLow.includes(hLow) && !titleLow.includes(aLow)) continue;
      const key = title.toLowerCase().slice(0, 50);
      if (seen.has(key)) continue;
      seen.add(key);
      headlines.push({
        title,
        source: art.source?.name || "News",
        published_at: art.publishedAt || null,
        url: art.url || null,
        tag: classifyHeadline(`${title} ${desc}`),
      });
      if (headlines.length >= 3) break;
    }
    const tags = [...new Set(headlines.map((h) => h.tag))];
    const riskLevel = tags.some((t) => t === "INJURY_SHOCK" || t === "MANAGER_CRISIS" || t === "SUSPENSION_BAN")
      ? "ALERT"
      : tags.includes("ROTATION_HINT")
        ? "WATCH"
        : tags.includes("SQUAD_BOOST")
          ? "BOOST"
          : "CLEAR";
    return {
      home: homeName,
      away: awayName,
      fetched_at: new Date().toISOString(),
      risk_level: riskLevel,
      signals: tags,
      headlines,
    };
  } catch {
    return null;
  }
}

function loadEngineSource() {
  const candidates = [
    path.join(ROOT, "docs", "engine.js"),
    path.join(ROOT, "index.html"),
    path.join(ROOT, "release", "index.html"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    if (file.endsWith(".js")) return raw;
    const startIdx = raw.indexOf("const ObsidianEngine = (() => {");
    if (startIdx >= 0) {
      const endMarker = "})();";
      const scriptEnd = raw.indexOf("</script>", startIdx);
      const endIdx = raw.lastIndexOf(endMarker, scriptEnd > 0 ? scriptEnd : raw.length);
      if (endIdx > startIdx) return raw.slice(startIdx, endIdx + endMarker.length);
    }
  }
  throw new Error("Could not find ObsidianEngine in index.html or docs/engine.js");
}

function createFileBackedStorage(memoryFile) {
  const store = {};
  if (fs.existsSync(memoryFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
      if (Array.isArray(parsed.predictions)) store["obsidian_v18_live_predictions"] = JSON.stringify(parsed.predictions);
      if (parsed.weights) store["obsidian_v18_live_weights"] = JSON.stringify(parsed.weights);
      if (Array.isArray(parsed.logs)) store["obsidian_v18_live_logs"] = JSON.stringify(parsed.logs);
      if (parsed.bankroll) store["obsidian_v18_bankroll"] = JSON.stringify(parsed.bankroll);
      if (parsed.usage) store["obsidian_v18_usage"] = JSON.stringify(parsed.usage);
    } catch (e) {
      console.warn("Could not parse existing memory.json, starting fresh:", e.message);
    }
  }
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _raw: store,
  };
}

async function sendTelegram(token, chatId, htmlText) {
  if (!token || !chatId) {
    console.log("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — printing message to stdout instead:\n" + htmlText);
    return { skipped: true };
  }
  // Split cleanly on double-newlines if message > 3900 chars
  const chunks = [];
  if (htmlText.length <= 3900) {
    chunks.push(htmlText);
  } else {
    let cur = "";
    for (const block of htmlText.split("\n\n")) {
      if ((cur + "\n\n" + block).length > 3800 && cur) {
        chunks.push(cur);
        cur = block;
      } else {
        cur = cur ? `${cur}\n\n${block}` : block;
      }
    }
    if (cur) chunks.push(cur);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cleanToken = String(token || "").replace(/^["']|["']$/g, "").trim();
  const chatIds = String(chatId || "")
    .replace(/^["']|["']$/g, "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!chatIds.length) {
    console.log("TELEGRAM_CHAT_ID empty — skipping Telegram send.");
    return { skipped: true };
  }

  // Safe diagnostic (prints zero secrets): token SHAPE only + bot identity + webhook state
  const shapeOk = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(cleanToken);
  const idsValid = chatIds.every((id) => /^-?\d+$/.test(id) || /^@[A-Za-z0-9_]{4,}$/.test(id));
  console.log(`[Telegram Token Shape] len=${cleanToken.length} format=${shapeOk ? "OK" : "INVALID"} whitespace=${/\s/.test(String(token))} quotes=${/["']/.test(String(token))} | recipients=${chatIds.length} valid=${idsValid}`);
  try {
    const meR = await fetch(`https://api.telegram.org/bot${cleanToken}/getMe`);
    const meJ = await meR.json().catch(() => ({}));
    const whR = await fetch(`https://api.telegram.org/bot${cleanToken}/getWebhookInfo`);
    const whJ = await whR.json().catch(() => ({}));
    console.log(`[Telegram Check] getMe HTTP ${meR.status} ok=${meJ.ok} bot=@${meJ.result?.username || "?"} ${meJ.ok ? "" : `desc="${meJ.description || "?"}"`} | webhook=${whJ.result?.url ? "ACTIVE" : "none"} | pending_updates=${whJ.result?.pending_update_count ?? 0}`);
    if (meR.status === 401 || meR.status === 404) {
      throw new Error(`Telegram token rejected (getMe ${meR.status}) — token salah/sudah di-revoke. Update secret TELEGRAM_BOT_TOKEN.`);
    }
    if (meR.status === 429) {
      throw new Error(`Telegram token throttled at TOKEN level (getMe 429, retry_after=${meJ?.parameters?.retry_after}). Bukan masalah pesan/IP — /revoke token di @BotFather atau buat bot baru, lalu update secret TELEGRAM_BOT_TOKEN.`);
    }
  } catch (e) {
    if (String(e?.message || "").startsWith("Telegram token")) throw e;
  }

  const results = [];
  for (let rIdx = 0; rIdx < chatIds.length; rIdx++) {
    const targetId = chatIds[rIdx];
    let recipientOk = true;
    let lastErr = null;
    for (let i = 0; i < chunks.length; i++) {
      let sent = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        // On retry after 429, drop inline_keyboard & use plain dashboard link in case Telegram throttles URL buttons on new bots
        const useButton = attempt === 1 && i === chunks.length - 1;
        const textOut = (!useButton && i === chunks.length - 1)
          ? `${chunks[i]}\n\n🔗 ${DASHBOARD_URL}`
          : chunks[i];
        const body = {
          chat_id: targetId,
          text: textOut,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        };
        if (useButton) {
          body.reply_markup = {
            inline_keyboard: [[{ text: "Buka VIP Dashboard · Engine Bola", url: DASHBOARD_URL }]],
          };
        }

        const resp = await fetch(`https://api.telegram.org/bot${cleanToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await resp.json().catch(() => ({}));
        if (resp.ok && json.ok) {
          sent = true;
          break;
        }
        if (resp.status === 429 && attempt < 3) {
          const waitSec = Math.min(75, Math.max(5, Number(json?.parameters?.retry_after || 20) + 5));
          console.warn(`[Telegram 429] Recipient #${rIdx + 1} rate limited (retry_after=${json?.parameters?.retry_after}) — waiting ${waitSec}s before retry ${attempt + 1}/3...`);
          await sleep(waitSec * 1000);
          continue;
        }
        lastErr = `HTTP ${resp.status}: ${json?.description || JSON.stringify(json)}`;
        break;
      }
      if (!sent) {
        recipientOk = false;
        console.warn(`[Telegram] Recipient #${rIdx + 1} failed: ${lastErr || "unknown error"}`);
        break;
      }
      if (i < chunks.length - 1) await sleep(1200);
    }
    results.push({ recipient: rIdx + 1, ok: recipientOk, ...(lastErr ? { error: lastErr } : {}) });
    if (rIdx < chatIds.length - 1) await sleep(1200);
  }

  const delivered = results.filter((r) => r.ok).length;
  if (delivered === 0) {
    throw new Error(`Telegram sendMessage failed for all ${chatIds.length} recipient(s): ${results[0]?.error || "unknown"}`);
  }
  return { ok: delivered === chatIds.length, delivered, total: chatIds.length, chunks: chunks.length };
}

function rcShort(code) {
  const map = {
    HIERARCHY_TRIUMPH: "Analisis Tepat",
    PROTECTED_REFUND: "Proteksi Modal Kembali",
    LINEUP_ROTATION_SHOCK: "Rotasi Susunan Pemain",
    SQUAD_INJURY_CRISIS: "Krisis Cedera Skuad",
    FATIGUE_HANGOVER_SHOCK: "Kelelahan Jadwal Padat",
    FILTER_WARNING_IGNORED: "Peringatan Risiko",
    DATA_GAP_UNDER_SAMPLE: "Data Terbatas",
    OVERCONFIDENT_LAMBDA_BIAS: "Kalibrasi Tempo Gol",
    BLACK_SWAN_VARIANCE: "Variansi Penyelesaian",
  };
  return map[code] || code || "Evaluasi Umum";
}

function fmtDateIndo(dateObj) {
  try {
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: TZ_WIB,
      weekday: "long",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(dateObj);
  } catch {
    return fmtDate(dateObj, TZ_WIB);
  }
}

function stakeDescriptor(u) {
  const v = Number(u || 0);
  if (v >= 3.0) return `Tinggi (${v}u)`;
  if (v >= 1.75) return `Normal (${v}u)`;
  if (v >= 1.0) return `Sedang (${v}u)`;
  return `Ringan (${v}u)`;
}

function newsTagIndo(tag) {
  const map = {
    INJURY_SHOCK: "Info Cedera",
    SUSPENSION_BAN: "Info Skorsing",
    MANAGER_CRISIS: "Situasi Pelatih",
    ROTATION_HINT: "Potensi Rotasi",
    SQUAD_BOOST: "Kabar Positif Skuad",
  };
  return map[tag] || null;
}

function humanizeMarket(key, fallbackLabel, home, away) {
  const h = home || "Team 1";
  const a = away || "Team 2";
  const map = {
    over_1_5: {
      title: "Total Over (1.5)",
      explain: "Menang jika total gol pertandingan minimal 2 gol.",
    },
    over_2_0_asian: {
      title: "Total Over (2)",
      explain: "3+ gol menang penuh · tepat 2 gol refund (modal kembali).",
    },
    over_2_25: {
      title: "Asian Total Over (2.25)",
      explain: "3+ gol menang penuh · tepat 2 gol setengah modal kembali.",
    },
    over_2_5: {
      title: "Total Over (2.5)",
      explain: "Menang jika total gol kedua tim minimal 3 gol.",
    },
    over_3_5: {
      title: "Total Over (3.5)",
      explain: "Menang jika tercipta minimal 4 gol sepanjang laga.",
    },
    under_2_5: {
      title: "Total Under (2.5)",
      explain: "Menang jika total gol maksimal 2 gol (laga ketat).",
    },
    under_2_75: {
      title: "Asian Total Under (2.75)",
      explain: "0–2 gol menang penuh · tepat 3 gol setengah modal kembali.",
    },
    under_3_0_asian: {
      title: "Total Under (3)",
      explain: "0–2 gol menang penuh · tepat 3 gol refund (modal kembali).",
    },
    under_3_5: {
      title: "Total Under (3.5)",
      explain: "Menang jika total gol tidak lebih dari 3 gol.",
    },
    btts_yes: {
      title: "BTTS Yes",
      explain: `Menang jika ${h} dan ${a} sama-sama cetak gol (Both Teams To Score).`,
    },
    btts_no: {
      title: "BTTS No",
      explain: "Menang jika minimal satu tim gagal mencetak gol.",
    },
    "1h_over_0_5": {
      title: "1st Half · Total Over (0.5)",
      explain: "Menang jika sudah ada minimal 1 gol di babak pertama (HT).",
    },
    "1h_over_1_5": {
      title: "1st Half · Total Over (1.5)",
      explain: "Menang jika tercipta minimal 2 gol di babak pertama.",
    },
    home_over_0_5: {
      title: `Individual Total 1 Over (0.5) · ${h}`,
      explain: `Menang selama ${h} mencetak minimal 1 gol.`,
    },
    away_over_0_5: {
      title: `Individual Total 2 Over (0.5) · ${a}`,
      explain: `Menang selama ${a} mencetak minimal 1 gol.`,
    },
    home_cs_yes: {
      title: `${h} Clean Sheet - Yes (IT2 Under 0.5)`,
      explain: `Menang jika ${a} gagal mencetak gol (0 gol).`,
    },
    away_cs_yes: {
      title: `${a} Clean Sheet - Yes (IT1 Under 0.5)`,
      explain: `Menang jika ${h} gagal mencetak gol (0 gol).`,
    },
    "1x2_home": {
      title: `W1 (${h} Win)`,
      explain: `Menang jika ${h} unggul di skor akhir waktu normal.`,
    },
    "1x2_draw": {
      title: "X (Draw)",
      explain: "Menang jika skor berakhir imbang di waktu normal.",
    },
    "1x2_away": {
      title: `W2 (${a} Win)`,
      explain: `Menang jika ${a} unggul di skor akhir waktu normal.`,
    },
    dc_1x: {
      title: `Double Chance 1X (${h})`,
      explain: `Menang jika ${h} menang atau seri (tidak kalah).`,
    },
    dc_x2: {
      title: `Double Chance 2X (${a})`,
      explain: `Menang jika ${a} menang atau seri (tidak kalah).`,
    },
    home_dnb: {
      title: `Handicap 1 (0) · ${h} DNB`,
      explain: `${h} menang = profit · jika seri = refund (modal kembali).`,
    },
    away_dnb: {
      title: `Handicap 2 (0) · ${a} DNB`,
      explain: `${a} menang = profit · jika seri = refund (modal kembali).`,
    },
    home_ah_m025: {
      title: `Asian Handicap 1 (-0.25) · ${h}`,
      explain: `${h} menang = profit penuh · seri = setengah modal kembali.`,
    },
    away_ah_p025: {
      title: `Asian Handicap 2 (+0.25) · ${a}`,
      explain: `${a} menang = profit penuh · seri = setengah profit.`,
    },
    home_ah_p1: {
      title: `Asian Handicap 1 (+1) · ${h}`,
      explain: `${h} menang/seri = profit · kalah tepat 1 gol = refund.`,
    },
    away_ah_p1: {
      title: `Asian Handicap 2 (+1) · ${a}`,
      explain: `${a} menang/seri = profit · kalah tepat 1 gol = refund.`,
    },
  };
  if (map[key]) return map[key];
  const cm = String(key || "").match(/^corners_over_(\d+)_5$/);
  if (cm) {
    const n = Number(cm[1]) + 1;
    return {
      title: `Corners · Total Over (${cm[1]}.5)`,
      explain: `Menang jika total korner kedua tim minimal ${n} korner.`,
    };
  }
  const cu = String(key || "").match(/^corners_under_(\d+)_5$/);
  if (cu) {
    return {
      title: `Corners · Total Under (${cu[1]}.5)`,
      explain: `Menang jika total korner tidak lebih dari ${cu[1]} korner.`,
    };
  }
  const ch = String(key || "").match(/^home_corners_over_(\d+)_5$/);
  if (ch) {
    const n = Number(ch[1]) + 1;
    return {
      title: `Corners · IT1 Over (${ch[1]}.5) · ${h}`,
      explain: `Menang jika ${h} meraih minimal ${n} korner.`,
    };
  }
  const ca = String(key || "").match(/^away_corners_over_(\d+)_5$/);
  if (ca) {
    const n = Number(ca[1]) + 1;
    return {
      title: `Corners · IT2 Over (${ca[1]}.5) · ${a}`,
      explain: `Menang jika ${a} meraih minimal ${n} korner.`,
    };
  }
  return { title: fallbackLabel || key, explain: "" };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const localStorage = createFileBackedStorage(MEMORY_PATH);

  // Inject API-Football key strictly at runtime from env (never persisted to memory.json!)
  const afKey = (process.env.API_FOOTBALL_KEY || "").trim();
  if (afKey) {
    localStorage.setItem("obsidian_v18_af_key", afKey);
    localStorage.setItem("obsidian_v18_af_autofill", "true");
  }

  const engineCode = loadEngineSource();
  const ctx = {
    localStorage,
    fetch: globalThis.fetch,
    console, Date, Math, Set, Map, Promise, JSON, Number, String, Array, Object, Boolean, Error, TypeError,
    Intl, parseInt, parseFloat, isNaN, encodeURIComponent,
  };
  vm.createContext(ctx);
  vm.runInContext(engineCode + "\nglobalThis.ObsidianEngine = ObsidianEngine;", ctx);
  const eng = ctx.ObsidianEngine;

  const now = new Date();
  const todayAmt = fmtDate(now, TZ_AMT);
  const scanLimit = parseInt(process.env.SCAN_LIMIT || "14", 10);
  const XI_NOTIFIED_PATH = path.join(DATA_DIR, "xi_notified.json");

  // Auto-detect mode: Full Briefing on morning/evening/manual runs, XI_SNIPER on T-60' prime-time crons
  const sched = String(process.env.GITHUB_SCHEDULE || "").trim();
  const xiSchedules = new Set(["20 11 * * *", "55 13 * * *", "35 16 * * *", "55 18 * * *"]);
  const botMode = (process.env.BOT_MODE || (xiSchedules.has(sched) ? "xi_sniper" : "full")).toLowerCase();

  console.log(`[Obsidian V18.6 Auto-Bot] Start ${todayAmt} (${fmtTime(now, TZ_AMT)} AMT / ${fmtTime(now, TZ_WIB)} WIB) · Mode=${botMode.toUpperCase()}`);

  // Helper to resolve Telegram recipients via Cloudflare Access Gate (with TELEGRAM_CHAT_ID fallback)
  async function resolveTelegramTargets() {
    let targetChatIds = (process.env.TELEGRAM_CHAT_ID || "").trim();
    const gateUrl = (process.env.OBSIDIAN_GATE_URL || "").trim().replace(/\/$/, "");
    const syncSecret = (process.env.BOT_SYNC_SECRET || "").trim();
    if (gateUrl && syncSecret) {
      try {
        const subResp = await fetch(`${gateUrl}/api/subscribers`, {
          headers: { Authorization: `Bearer ${syncSecret}` },
        });
        const subJson = await subResp.json().catch(() => ({}));
        if (subResp.ok && subJson.ok && Array.isArray(subJson.chat_ids) && subJson.chat_ids.length) {
          targetChatIds = subJson.chat_ids.join(",");
          console.log(`[Access Gate] Synced ${subJson.chat_ids.length} target(s) (${subJson.mode || "list"}) from Cloudflare KV.`);
        } else {
          console.warn(`[Access Gate] Subscriber sync returned HTTP ${subResp.status}; falling back to TELEGRAM_CHAT_ID.`);
        }
      } catch (e) {
        console.warn(`[Access Gate] Subscriber sync error (${e?.message || e}); falling back to TELEGRAM_CHAT_ID.`);
      }
    }
    return targetChatIds;
  }

  // 1. Auto-settle all finished matches (server-side = no browser CORS block -> exact corners & 1H goals!)
  const beforeSettledIds = new Set(
    eng.listPredictions("ALL").filter((p) => p.status !== "PENDING").map((p) => p.id)
  );
  const settleRes = await eng.autoSettlePending();
  const newlySettled = eng
    .listPredictions("ALL")
    .filter((p) => p.status !== "PENDING" && !beforeSettledIds.has(p.id));
  console.log(`[Auto-Settle] Checked ${settleRes.checked}, newly settled: ${settleRes.settled_count}`);

  // 2. Fetch today's slate (AMT calendar)
  let slate = await eng.fetchMatchesByDate(todayAmt, true);
  let flat = (slate.leagues || []).flatMap((l) => l.matches || []);
  let activeDate = todayAmt;
  const openToday = flat.filter((m) => !m.finished && !String(m.match_id).startsWith("espn:"));
  if (openToday.length < 3) {
    const tmrwAmt = fmtDate(new Date(now.getTime() + 86400000), TZ_AMT);
    const tSlate = await eng.fetchMatchesByDate(tmrwAmt, true);
    const tFlat = (tSlate.leagues || []).flatMap((l) => l.matches || []);
    flat = [...openToday, ...tFlat.filter((m) => !m.finished)];
    activeDate = openToday.length ? `${todayAmt} + ${tmrwAmt}` : tmrwAmt;
  }

  // ---- STAGE 2: CONFIRMED-XI SNIPER MODE (T-75' to T-10' pre-kickoff window, zero spam) ----
  if (botMode === "xi_sniper") {
    let notified = {};
    if (fs.existsSync(XI_NOTIFIED_PATH)) {
      try { notified = JSON.parse(fs.readFileSync(XI_NOTIFIED_PATH, "utf8")) || {}; } catch {}
    }
    // Prune entries older than 36h
    const cutoff = Date.now() - 36 * 3600 * 1000;
    for (const [k, ts] of Object.entries(notified)) {
      if (Number(ts) < cutoff) delete notified[k];
    }

    const soonMatches = flat
      .filter((m) => {
        if (m.finished || m.is_live || String(m.match_id).startsWith("espn:")) return false;
        if (notified[String(m.match_id)]) return false;
        const ko = m.kickoff_utc ? new Date(m.kickoff_utc).getTime() : NaN;
        if (Number.isNaN(ko)) return false;
        const minsToKo = (ko - now.getTime()) / 60000;
        return minsToKo >= 8 && minsToKo <= 88;
      })
      .sort((a, b) => (a.is_priority ? 0 : 1) - (b.is_priority ? 0 : 1))
      .slice(0, 12);

    console.log(`[XI Sniper] Checking ${soonMatches.length} fixture(s) kicking off in 8–88 mins for Official Starting XI...`);
    const confirmedAudits = [];
    for (const m of soonMatches) {
      try {
        const a = await eng.analyzeMatchById(m.match_id, { forceRefresh: true });
        if (!a || !a.xi_confirmed || a.verdict.tier_code === "TIER_4") continue;
        // Skip thin-data obscure minor leagues (e.g. non-league / Highland League) so @enginebola stays sharp
        if (!a.is_priority && Number(a.data_confidence || 0) < 68) {
          console.log(`[XI Sniper] Skipping thin-data non-priority match: ${a.home.name} vs ${a.away.name} (${a.league_name}, conf=${a.data_confidence})`);
          continue;
        }
        confirmedAudits.push(a);
        notified[String(a.match_id)] = Date.now();
      } catch {}
    }

    // Save updated memory (with Confirmed-XI updates & any auto-settlements)
    const backupObj = JSON.parse(eng.exportBackup());
    backupObj.synced_by = "github_actions_xi_sniper";
    backupObj.usage = eng.getUsage();
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(backupObj, null, 2), "utf8");
    fs.writeFileSync(XI_NOTIFIED_PATH, JSON.stringify(notified, null, 2), "utf8");

    if (!confirmedAudits.length) {
      console.log("[XI Sniper] No new Confirmed-XI qualifying matches right now — skipping Telegram send (zero spam).");
      return;
    }

    const shiftedCount = confirmedAudits.filter((a) => a.xi_shift && a.xi_shift.changed).length;
    const xiLines = [];
    xiLines.push(`⚽ <b>ENGINE BOLA · UPDATE LINI PEMAIN RESMI</b>`);
    xiLines.push(`<i>${escHtml(fmtDateIndo(now))} · ${fmtTime(now, TZ_AMT)} AMT / ${fmtTime(now, TZ_WIB)} WIB</i>`);
    xiLines.push(`<i>Susunan pemain (Starting XI) resmi telah terkonfirmasi untuk ${confirmedAudits.length} pertandingan berikut${shiftedCount ? ` · 🔄 <b>${shiftedCount} prediksi berubah pasca XI!</b>` : ""}:</i>`);

    confirmedAudits.forEach((a, idx) => {
      const sp = a.verdict.sniper_pick;
      const v = a.verdict;
      const cm = a.corners_model;
      const lgEm = a.league_emoji || eng.getLeagueEmoji(a.league_name, a.country_code);
      const hFlag = a.home.flag || eng.getTeamFlag(a.home.name, a.league_name, a.country_code);
      const aFlag = a.away.flag || eng.getTeamFlag(a.away.name, a.league_name, a.country_code);
      const priInfo = humanizeMarket(v.market_key, v.primary_bet, a.home.name, a.away.name);
      const spInfo = sp ? humanizeMarket(sp.key, sp.label, a.home.name, a.away.name) : null;
      const card = [
        `<b>${idx + 1}. ${hFlag} ${escHtml(a.home.name)} vs ${aFlag} ${escHtml(a.away.name)}</b>`,
        `${lgEm} ${escHtml(a.league_name)} · <code>${escHtml(fmtKickoffDual(a.kickoff_utc))}</code>`,
        `Formasi Resmi: <b>${escHtml(a.home.formation)}</b> vs <b>${escHtml(a.away.formation)}</b>`,
      ];
      if (a.xi_shift && a.xi_shift.changed && a.xi_shift.before) {
        const bInfo = humanizeMarket(a.xi_shift.before.market_key, a.xi_shift.before.market_label, a.home.name, a.away.name);
        card.push(`🔄 <b>PERUBAHAN PASCA XI RESMI:</b>`);
        card.push(`   • Sebelum (Pre-XI): <s>${escHtml(bInfo.title)}</s> (${Math.round(a.xi_shift.before.model_prob)}%)`);
        card.push(`   • Sekarang (Resmi XI): <b>${escHtml(priInfo.title)}</b> (${Math.round(a.xi_shift.after.model_prob)}%)`);
        card.push(`   • <b>Kenapa:</b> <i>${escHtml(a.xi_shift.why)}</i>`);
        card.push(`   • <b>Arah:</b> <i>${escHtml(a.xi_shift.how)}</i>`);
      } else if (a.xi_shift && a.xi_shift.significant) {
        const d = a.xi_shift.prob_delta;
        card.push(`📊 <b>PERGESERAN PELUANG PASCA XI (${d >= 0 ? "+" : ""}${d}%):</b> <i>${escHtml(a.xi_shift.why)}</i>`);
      }
      if (sp && spInfo) {
        card.push(`▸ <b>Pilihan Aman: ${escHtml(spInfo.title)}</b> (<b>${Math.round(sp.model_prob)}%</b>)`);
        if (spInfo.explain) card.push(`   <i>${escHtml(spInfo.explain)}</i>`);
      }
      const priceNote = v.bookmaker_odds
        ? ` · Odds <b>${v.bookmaker_odds}</b>`
        : ` · Fair Odds <b>${v.fair_odds}</b>`;
      card.push(`▸ <b>Pilihan Utama: ${escHtml(priInfo.title)}</b> (<b>${Math.round(v.model_prob)}%</b>${priceNote})`);
      if (priInfo.explain && (!sp || sp.key !== v.market_key)) {
        card.push(`   <i>${escHtml(priInfo.explain)}</i>`);
      }
      card.push(`▸ Porsi Modal: <b>${escHtml(stakeDescriptor(v.stake_units))}</b> · Est. <b>~${a.goal_model.total_lambda.toFixed(1)} gol</b>`);
      if (cm.high_volume_10_15) {
        const cParts = [`Total Over (10.5) <b>${Math.round(cm.p_over_10_5)}%</b>`, `Over (11.5) <b>${Math.round(cm.p_over_11_5)}%</b>`, `Over (12.5) <b>${Math.round(cm.p_over_12_5)}%</b>`];
        if (cm.p_over_13_5 >= 35) cParts.push(`Over (13.5) <b>${Math.round(cm.p_over_13_5)}%</b>`);
        card.push(`▸ 🚩 Corners (~${Math.round(cm.total_corners_lambda)} est.): ${cParts.join(" · ")}`);
      }
      xiLines.push("");
      xiLines.push(`<blockquote>${card.join("\n")}</blockquote>`);
    });

    xiLines.push("");
    xiLines.push(`<i>Seluruh analisis di atas telah memperhitungkan daftar pemain starter resmi &amp; otomatis menandai jika prediksi berubah dari Pre-XI.</i>`);

    const msg = xiLines.join("\n");
    try { fs.writeFileSync(path.join(DATA_DIR, "last_report.txt"), msg); } catch {}
    const targetChatIds = await resolveTelegramTargets();
    try {
      const tgRes = await sendTelegram((process.env.TELEGRAM_BOT_TOKEN || "").trim(), targetChatIds, msg);
      console.log("[Telegram XI Sniper]", tgRes);
    } catch (e) {
      console.warn(`::warning title=Telegram XI Sniper not delivered::${e?.message || e}`);
    }
    return;
  }

  // ---- STAGE 1: FULL BRIEFING MODE ----
  console.log(`[Daily Scanner] Scanning up to ${scanLimit} priority fixtures from ${flat.length} matches (${activeDate})...`);
  const scanRes = await eng.scanDailyTopPicks(flat, scanLimit);
  const analytics = eng.getAnalytics();

  // 3. Persist memory.json (NO secrets!) & daily_picks.json for Browser Auto-Sync
  const backupObj = JSON.parse(eng.exportBackup());
  backupObj.synced_by = "github_actions_auto_bot";
  backupObj.usage = eng.getUsage();
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(backupObj, null, 2), "utf8");

  const compactPick = (a, m) => ({
    match_id: a.match_id,
    league: a.league_name,
    league_emoji: a.league_emoji || eng.getLeagueEmoji(a.league_name, a.country_code),
    country_code: a.country_code || "",
    home: a.home.name,
    home_flag: a.home.flag || eng.getTeamFlag(a.home.name, a.league_name, a.country_code),
    away: a.away.name,
    away_flag: a.away.flag || eng.getTeamFlag(a.away.name, a.league_name, a.country_code),
    kickoff_utc: a.kickoff_utc,
    kickoff_dual: fmtKickoffDual(a.kickoff_utc),
    xi_confirmed: a.xi_confirmed,
    xi_shift: a.xi_shift || null,
    market_key: m.key,
    market: m.label,
    model_prob: m.model_prob,
    fair_odds: m.fair_odds,
    bookmaker_odds: m.bookmaker_odds,
    edge_pct: m.edge_pct,
    push_prob: m.push_prob || 0,
    tier: a.verdict.tier,
    tier_code: a.verdict.tier_code,
    stake_units: a.verdict.stake_units,
    projected_score: a.goal_model.projected_score,
    total_lambda: a.goal_model.total_lambda,
  });

  const sniperPicks = (scanRes.sniper_anchors || []).slice(0, 3).map(({ analysis, market }) => compactPick(analysis, market));
  const topAnchors = (scanRes.anchors || []).slice(0, 3).map((a) => {
    const m = a.all_markets.find((x) => x.key === a.verdict.market_key) || a.radar[0];
    return compactPick(a, m);
  });
  const highCorners1015 = (scanRes.high_corners_10_15 || []).slice(0, 3).map((c) => ({
    match_id: c.analysis.match_id,
    league: c.analysis.league_name,
    league_emoji: c.analysis.league_emoji || eng.getLeagueEmoji(c.analysis.league_name, c.analysis.country_code),
    home: c.analysis.home.name,
    home_flag: c.analysis.home.flag || eng.getTeamFlag(c.analysis.home.name, c.analysis.league_name, c.analysis.country_code),
    away: c.analysis.away.name,
    away_flag: c.analysis.away.flag || eng.getTeamFlag(c.analysis.away.name, c.analysis.league_name, c.analysis.country_code),
    kickoff_dual: fmtKickoffDual(c.analysis.kickoff_utc),
    total_corners_lambda: c.total_corners_lambda,
    market: c.market?.label || "Corners · Total Over (10.5)",
    model_prob: c.market?.model_prob ?? c.p_over_10_5,
    p_over_10_5: c.p_over_10_5,
    p_over_11_5: c.p_over_11_5,
    p_over_12_5: c.p_over_12_5,
    p_over_13_5: c.p_over_13_5,
    p_over_14_5: c.p_over_14_5,
  }));
  const topCorners = (scanRes.best_corners || []).slice(0, 3).map(({ analysis, market }) => compactPick(analysis, market));
  const topGoals = (scanRes.best_goals || []).slice(0, 3).map(({ analysis, market }) => compactPick(analysis, market));
  const topBtts = (scanRes.best_btts || []).slice(0, 2).map(({ analysis, market }) => compactPick(analysis, market));
  const autoParlay3 = (scanRes.analyses && scanRes.analyses.length >= 3 && eng.buildAutoParlay)
    ? eng.buildAutoParlay(scanRes.analyses, { legs: 3, mode: "SAFE" })
    : null;

  // 2b. NewsAPI.org Pre-Match Intelligence (server-side = zero CORS block, max 6 calls/run to stay well under 100/day!)
  const newsApiKey = (process.env.NEWS_API_KEY || "").trim();
  const newsByMatch = {};
  let newsCalls = 0;
  if (newsApiKey && topAnchors.length) {
    console.log(`[NewsAPI] Scanning pre-match breaking news for top ${topAnchors.length} picks...`);
    for (const pick of topAnchors) {
      const intel = await fetchNewsIntelForMatch(pick.home, pick.away, newsApiKey);
      newsCalls++;
      if (intel && intel.headlines.length) {
        newsByMatch[String(pick.match_id)] = intel;
        pick.news_risk_level = intel.risk_level;
        pick.news_signals = intel.signals;
        pick.news_headline = intel.headlines[0].title;
        const predRow = (backupObj.predictions || []).find(
          (p) => String(p.match_id) === String(pick.match_id) && p.source_type === "AUTO"
        );
        if (predRow && predRow.factors) {
          predRow.factors.news_risk_level = intel.risk_level;
          predRow.factors.news_alerts = intel.signals;
        }
      }
    }
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(backupObj, null, 2), "utf8");
    fs.writeFileSync(
      NEWS_PATH,
      JSON.stringify({ generated_at: now.toISOString(), calls_used: newsCalls, by_match: newsByMatch }, null, 2),
      "utf8"
    );
    console.log(`[NewsAPI] Completed ${newsCalls} queries, found breaking intel on ${Object.keys(newsByMatch).length} matches.`);
  } else {
    if (!fs.existsSync(NEWS_PATH)) {
      fs.writeFileSync(NEWS_PATH, JSON.stringify({ generated_at: now.toISOString(), calls_used: 0, by_match: {} }, null, 2), "utf8");
    }
  }

  fs.writeFileSync(
    PICKS_PATH,
    JSON.stringify({
      generated_at: now.toISOString(),
      date_label: activeDate,
      scanned: scanRes.scanned,
      sniper_picks: sniperPicks,
      top_anchors: topAnchors,
      high_corners_10_15: highCorners1015,
      top_corners: topCorners,
      top_goals: topGoals,
      top_btts: topBtts,
    }, null, 2),
    "utf8"
  );

  // 4. Build sleek, editorial, beginner-friendly Telegram HTML brief
  const lines = [];
  lines.push(`⚽ <b>ENGINE BOLA · DAILY RADAR</b>`);
  lines.push(`<i>${escHtml(fmtDateIndo(now))} · ${fmtTime(now, TZ_AMT)} AMT / ${fmtTime(now, TZ_WIB)} WIB</i>`);

  // Compact executive recap (never clutters the channel with verbose debug logs)
  const s = analytics.summary;
  if (newlySettled.length > 0) {
    const nw = newlySettled.filter((p) => p.status === "WON" || p.status === "HALF_WON").length;
    const nl = newlySettled.filter((p) => p.status === "LOST" || p.status === "HALF_LOST").length;
    const np = newlySettled.filter((p) => p.status === "PUSH").length;
    const rec = [
      `📊 <b>REKAP HASIL SEMALAM (${newlySettled.length} Laga)</b>`,
      `Menang <b>${nw}</b> · Seri/Refund <b>${np}</b> · Kalah <b>${nl}</b>`,
      `<i>Model otomatis mengevaluasi hasil &amp; memperbarui kalibrasi. Rincian lengkap 5W1H tersedia di VIP Dashboard.</i>`,
    ];
    lines.push("");
    lines.push(`<blockquote>${rec.join("\n")}</blockquote>`);
  } else if (s.settled > 0) {
    lines.push("");
    lines.push(`<blockquote>📊 <b>REKAM JEJAK MODEL</b>\nAkurasi: <b>${s.hit_rate}%</b> (${s.wins} Menang · ${s.pushes} Seri · ${s.losses} Kalah)</blockquote>`);
  }

  // Helper to render one clean editorial match card
  const renderPickCard = (p, idx, isSniper = false) => {
    const info = humanizeMarket(p.market_key, p.market, p.home, p.away);
    const lgEm = p.league_emoji || eng.getLeagueEmoji(p.league, p.country_code);
    const hFlag = p.home_flag || eng.getTeamFlag(p.home, p.league, p.country_code);
    const aFlag = p.away_flag || eng.getTeamFlag(p.away, p.league, p.country_code);
    const xiLine = p.xi_confirmed
      ? `Susunan Pemain: <b>Resmi Terkonfirmasi ✓</b>`
      : `Susunan Pemain: <i>Menunggu rilis resmi (T-60' sebelum kickoff)</i>`;
    const priceBit = p.bookmaker_odds
      ? ` · Odds <b>${p.bookmaker_odds}</b>`
      : ` · Fair Odds <b>${p.fair_odds}</b>`;
    const card = [
      `<b>${idx + 1}. ${hFlag} ${escHtml(p.home)} vs ${aFlag} ${escHtml(p.away)}</b>`,
      `${lgEm} ${escHtml(p.league)} · <code>${escHtml(p.kickoff_dual)}</code>`,
      `▸ Rekomendasi: <b>${escHtml(info.title)}</b>`,
      `▸ Peluang: <b>${Math.round(p.model_prob)}%</b>${priceBit}${isSniper ? "" : ` · Porsi <b>${escHtml(stakeDescriptor(p.stake_units))}</b>`}`,
    ];
    if (p.xi_shift && p.xi_shift.changed && p.xi_shift.before) {
      const bInfo = humanizeMarket(p.xi_shift.before.market_key, p.xi_shift.before.market_label, p.home, p.away);
      card.push(`▸ 🔄 <b>XI Shift:</b> <s>${escHtml(bInfo.title)}</s> → <b>${escHtml(info.title)}</b> (<i>${escHtml(p.xi_shift.why)}</i>)`);
    }
    if (info.explain) {
      card.push(`▸ Arti Singkat: <i>${escHtml(info.explain)}</i>`);
    }
    card.push(`▸ Estimasi Tempo: <b>~${Number(p.total_lambda || 2.5).toFixed(1)} gol</b> · ${xiLine}`);
    // Only show truly meaningful breaking news (skip generic TEAM_NEWS fluff!)
    const sigTag = (p.news_signals || []).map(newsTagIndo).find(Boolean);
    if (sigTag && p.news_headline) {
      card.push(`▸ ${escHtml(sigTag)}: <i>${escHtml(p.news_headline.slice(0, 95))}</i>`);
    }
    return `<blockquote>${card.join("\n")}</blockquote>`;
  };

  if (sniperPicks.length) {
    lines.push("");
    lines.push(`🎯 <b>PILIHAN UTAMA · AKURASI TINGGI</b>`);
    lines.push(`<i>Seleksi paling ketat — fokus peluang tertinggi &amp; proteksi modal.</i>`);
    sniperPicks.forEach((p, idx) => {
      lines.push("");
      lines.push(renderPickCard(p, idx, true));
    });
  }

  lines.push("");
  lines.push(`📡 <b>ANALISIS PILIHAN HARI INI</b>`);
  lines.push(`<i>Disaring dari ${scanRes.scanned} pertandingan prioritas hari ini.</i>`);
  if (!topAnchors.length) {
    lines.push("");
    lines.push(`<blockquote><i>Belum ada pertandingan yang memenuhi standar seleksi ketat saat ini.</i></blockquote>`);
  } else {
    topAnchors.forEach((p, idx) => {
      lines.push("");
      lines.push(renderPickCard(p, idx, false));
    });
  }

  if (highCorners1015.length) {
    lines.push("");
    lines.push(`🚩 <b>RADAR CORNERS TINGGI (10–15+ CORNERS)</b>`);
    lines.push(`<i>Laga dengan intensitas serangan sayap &amp; potensi tendangan sudut tinggi.</i>`);
    const cRows = highCorners1015.map((c) => {
      const tiers = [
        `Total Over (10.5) <b>${Math.round(c.p_over_10_5)}%</b>`,
        `Over (11.5) <b>${Math.round(c.p_over_11_5)}%</b>`,
        `Over (12.5) <b>${Math.round(c.p_over_12_5)}%</b>`,
      ];
      if (c.p_over_13_5 >= 35) tiers.push(`Over (13.5) <b>${Math.round(c.p_over_13_5)}%</b>`);
      if (c.p_over_14_5 >= 30) tiers.push(`Over (14.5) <b>${Math.round(c.p_over_14_5)}%</b>`);
      return `${c.home_flag} <b>${escHtml(c.home)} vs ${c.away_flag} ${escHtml(c.away)}</b> · ${c.league_emoji} <i>${escHtml(c.league)}</i>\nEst. <b>~${Math.round(c.total_corners_lambda)} corners</b> → ${tiers.join(" · ")}`;
    });
    lines.push("");
    lines.push(`<blockquote>${cRows.join("\n—\n")}</blockquote>`);
  } else if (topCorners.length) {
    lines.push("");
    lines.push(`🚩 <b>PILIHAN CORNERS TERBAIK</b>`);
    const cRows = topCorners.map((c) => {
      const info = humanizeMarket(c.market_key, c.market, c.home, c.away);
      return `• ${c.home_flag} <b>${escHtml(c.home)} vs ${c.away_flag} ${escHtml(c.away)}</b> (${c.league_emoji} ${escHtml(c.league)}) — <b>${escHtml(info.title)}</b> (<b>${Math.round(c.model_prob)}%</b>)`;
    });
    lines.push("");
    lines.push(`<blockquote>${cRows.join("\n")}</blockquote>`);
  }

  if (topBtts.length) {
    lines.push("");
    lines.push(`🔥 <b>BOTH TEAMS TO SCORE (BTTS)</b>`);
    const bRows = topBtts.map((b) => {
      const info = humanizeMarket(b.market_key, b.market, b.home, b.away);
      return `• ${b.home_flag} <b>${escHtml(b.home)} vs ${b.away_flag} ${escHtml(b.away)}</b> (${b.league_emoji} ${escHtml(b.league)}) — <b>${escHtml(info.title)}</b> (<b>${Math.round(b.model_prob)}%</b>)`;
    });
    lines.push("");
    lines.push(`<blockquote>${bRows.join("\n")}</blockquote>`);
  }

  // Append compact 3-Leg Auto-Parlay Safe only if final message remains under 3850 chars (1 single Telegram message!)
  if (autoParlay3 && autoParlay3.legs && autoParlay3.legs.length >= 3) {
    const pRows = autoParlay3.legs.map((l) => {
      const info = humanizeMarket(l.market.key, l.market.label, l.home, l.away);
      return `${l.index}. ${l.home_flag} <b>${escHtml(l.home)} vs ${l.away_flag} ${escHtml(l.away)}</b> (${l.league_emoji} ${escHtml(l.league)})\n   ▸ <b>${escHtml(info.title)}</b> (${Math.round(l.market.model_prob)}% · ${l.used_odds}x)`;
    });
    const parlayBlock = [
      ``,
      `🎟️ <b>AUTO-PARLAY 3-LEG SAFE</b> · Total <b>${autoParlay3.combined_odds.toFixed(2)}x</b> (Win <b>${autoParlay3.combined_win_prob}%</b>)`,
      `<blockquote>${pRows.join("\n")}</blockquote>`,
    ].join("\n");
    if ((lines.join("\n").length + parlayBlock.length + 180) < 3850) {
      lines.push(parlayBlock);
    }
  }

  lines.push("");
  lines.push(`<i>Catatan: Analisis bertanda "Menunggu rilis resmi" belum menyertakan daftar pemain starter. Update otomatis dikirim 1 jam sebelum kickoff saat Starting XI resmi keluar — termasuk penanda 🔄 jika prediksi berubah.</i>`);

  // Technical calibration metrics stay in stdout logs (not cluttering public channel)
  const fp = analytics.weights.factor_penalties || {};
  console.log(`[Neural Metrics] Goal×${analytics.weights.goal_lambda_scale} · Corner×${analytics.weights.corner_lambda_scale} · Pre-XI -${fp.pre_xi || 0} · AF ${backupObj.usage.api_football}/100 · News ${newsCalls}q`);

  const msg = lines.join("\n");
  try { fs.writeFileSync(path.join(DATA_DIR, "last_report.txt"), msg); } catch {}

  const targetChatIds = await resolveTelegramTargets();

  let tgRes;
  try {
    tgRes = await sendTelegram(
      (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
      targetChatIds,
      msg
    );
  } catch (e) {
    tgRes = { ok: false, error: String(e?.message || e) };
    console.warn(`::warning title=Telegram not delivered::${tgRes.error}`);
  }
  console.log("[Telegram]", tgRes);
  console.log("[Done] Saved data/memory.json, data/daily_picks.json, data/news_intel.json & data/last_report.txt");
}

main().catch((err) => {
  console.error("[Obsidian Auto-Bot ERROR]", err);
  process.exit(1);
});
