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
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://arnoldkarstark-art.github.io/obsidian-diamond-v18/";

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
      const combo = `${title} ${desc}`.toLowerCase();
      if (!combo.includes(hLow) && !combo.includes(aLow)) continue;
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
  const cleanChatId = String(chatId || "").replace(/^["']|["']$/g, "").trim();

  // Safe diagnostic (prints zero secrets): token SHAPE only + bot identity + webhook state
  const shapeOk = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(cleanToken);
  console.log(`[Telegram Token Shape] len=${cleanToken.length} format=${shapeOk ? "OK" : "INVALID"} whitespace=${/\s/.test(String(token))} quotes=${/["']/.test(String(token))} | chat_id_numeric=${/^-?\d+$/.test(cleanChatId)}`);
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

  for (let i = 0; i < chunks.length; i++) {
    let sent = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // On retry after 429, drop inline_keyboard & use plain dashboard link in case Telegram throttles URL buttons on new bots
      const useButton = attempt === 1 && i === chunks.length - 1;
      const textOut = (!useButton && i === chunks.length - 1)
        ? `${chunks[i]}\n\n🔗 ${DASHBOARD_URL}`
        : chunks[i];
      const body = {
        chat_id: cleanChatId,
        text: textOut,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      };
      if (useButton) {
        body.reply_markup = {
          inline_keyboard: [[{ text: "Buka Dashboard Obsidian V18.5", url: DASHBOARD_URL }]],
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
        console.warn(`[Telegram 429] Rate limited (retry_after=${json?.parameters?.retry_after}) — waiting ${waitSec}s before retry ${attempt + 1}/3 (plain link mode)...`);
        await sleep(waitSec * 1000);
        continue;
      }
      throw new Error(`Telegram sendMessage failed (${resp.status}): ${JSON.stringify(json)}`);
    }
    if (!sent) throw new Error("Telegram sendMessage failed after 3 attempts.");
    if (i < chunks.length - 1) await sleep(1500);
  }
  return { ok: true, chunks: chunks.length };
}

function rcShort(code) {
  const map = {
    HIERARCHY_TRIUMPH: "Hierarchy Triumph",
    PROTECTED_REFUND: "Asian Push Shield",
    LINEUP_ROTATION_SHOCK: "Lineup Rotation Shock",
    FATIGUE_HANGOVER_SHOCK: "Fatigue / Hangover",
    FILTER_WARNING_IGNORED: "Filter Warning",
    DATA_GAP_UNDER_SAMPLE: "xG / Corner Data Gap",
    OVERCONFIDENT_LAMBDA_BIAS: "Overconfident λ Bias",
    BLACK_SWAN_VARIANCE: "Black Swan Variance",
  };
  return map[code] || code || "Unclassified";
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

  console.log(`[Obsidian Auto-Bot] Start ${todayAmt} (${fmtTime(now, TZ_AMT)} AMT / ${fmtTime(now, TZ_WIB)} WIB)`);

  // 1. Auto-settle all finished matches (server-side = no browser CORS block -> exact corners & 1H goals!)
  const beforeSettledIds = new Set(
    eng.listPredictions("ALL").filter((p) => p.status !== "PENDING").map((p) => p.id)
  );
  const settleRes = await eng.autoSettlePending();
  const newlySettled = eng
    .listPredictions("ALL")
    .filter((p) => p.status !== "PENDING" && !beforeSettledIds.has(p.id));
  console.log(`[Auto-Settle] Checked ${settleRes.checked}, newly settled: ${settleRes.settled_count}`);

  // 2. Fetch today's slate (AMT calendar) + scan top priority fixtures
  let slate = await eng.fetchMatchesByDate(todayAmt, true);
  let flat = (slate.leagues || []).flatMap((l) => l.matches || []);
  let activeDate = todayAmt;
  const openToday = flat.filter((m) => !m.finished && !String(m.match_id).startsWith("espn:"));
  if (openToday.length < 3) {
    // Late night in Armenia: also include tomorrow's fixtures!
    const tmrwAmt = fmtDate(new Date(now.getTime() + 86400000), TZ_AMT);
    const tSlate = await eng.fetchMatchesByDate(tmrwAmt, true);
    const tFlat = (tSlate.leagues || []).flatMap((l) => l.matches || []);
    flat = [...openToday, ...tFlat.filter((m) => !m.finished)];
    activeDate = openToday.length ? `${todayAmt} + ${tmrwAmt}` : tmrwAmt;
  }

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
    home: a.home.name,
    away: a.away.name,
    kickoff_utc: a.kickoff_utc,
    kickoff_dual: fmtKickoffDual(a.kickoff_utc),
    xi_confirmed: a.xi_confirmed,
    market: m.label,
    model_prob: m.model_prob,
    fair_odds: m.fair_odds,
    bookmaker_odds: m.bookmaker_odds,
    edge_pct: m.edge_pct,
    tier: a.verdict.tier,
    tier_code: a.verdict.tier_code,
    stake_units: a.verdict.stake_units,
    projected_score: a.goal_model.projected_score,
  });

  const topAnchors = (scanRes.anchors || []).slice(0, 6).map((a) => {
    const m = a.all_markets.find((x) => x.key === a.verdict.market_key) || a.radar[0];
    return compactPick(a, m);
  });
  const topCorners = (scanRes.best_corners || []).slice(0, 3).map(({ analysis, market }) => compactPick(analysis, market));
  const topGoals = (scanRes.best_goals || []).slice(0, 3).map(({ analysis, market }) => compactPick(analysis, market));
  const topBtts = (scanRes.best_btts || []).slice(0, 2).map(({ analysis, market }) => compactPick(analysis, market));

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
        // Also attach news signals to the auto-recorded prediction in memory for 5W1H context
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
    // Keep file present (empty or existing) so browser fetch never 404s cleanly
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
      top_anchors: topAnchors,
      top_corners: topCorners,
      top_goals: topGoals,
      top_btts: topBtts,
    }, null, 2),
    "utf8"
  );

  // 4. Build crisp Telegram HTML message
  const lines = [];
  lines.push(`<b>OBSIDIAN V18.5 — DAILY RADAR</b>`);
  lines.push(`<code>${escHtml(activeDate)} · ${fmtTime(now, TZ_AMT)} AMT / ${fmtTime(now, TZ_WIB)} WIB</code>`);

  const s = analytics.summary;
  if (newlySettled.length > 0) {
    const nw = newlySettled.filter((p) => p.status === "WON" || p.status === "HALF_WON").length;
    const nl = newlySettled.filter((p) => p.status === "LOST" || p.status === "HALF_LOST").length;
    const np = newlySettled.filter((p) => p.status === "PUSH").length;
    const nPnl = +newlySettled.reduce((acc, p) => acc + (p.pnl_units || 0), 0).toFixed(2);
    lines.push("");
    lines.push(`<b>📊 AUTO-SETTLE &amp; 5W1H BARU (${newlySettled.length} match)</b>`);
    lines.push(`• Hasil: <b>${nw}W - ${nl}L - ${np}P</b> (${nPnl >= 0 ? "+" : ""}${nPnl}u)`);
    lines.push(`• Total Historis: Hit Rate <b>${s.hit_rate}%</b> · ROI <b>${s.roi_pct >= 0 ? "+" : ""}${s.roi_pct}%</b> · Brier <code>${s.mean_brier ?? "—"}</code>`);
    const misses = newlySettled.filter((p) => p.status === "LOST" || p.status === "HALF_LOST").slice(0, 3);
    for (const m of misses) {
      lines.push(`• <i>Miss</i>: ${escHtml(m.home_team)} vs ${escHtml(m.away_team)} (${escHtml(m.market_label)} → ${m.actual_home_goals}–${m.actual_away_goals})`);
      if (m.post_mortem) {
        lines.push(`  <b>WHY</b> [${escHtml(rcShort(m.post_mortem.root_cause))}]: ${escHtml(m.post_mortem.why)}`);
      }
    }
  } else if (s.settled > 0) {
    lines.push("");
    lines.push(`<b>📊 MEMORY TRACKER</b>`);
    lines.push(`• Tracked: <b>${s.total_saved}</b> (${s.pending} pending · ${s.settled} settled)`);
    lines.push(`• Hit Rate: <b>${s.hit_rate}%</b> (${s.wins}W-${s.losses}L-${s.pushes}P) · ROI <b>${s.roi_pct >= 0 ? "+" : ""}${s.roi_pct}%</b>`);
  }

  lines.push("");
  lines.push(`<b>🔥 TOP PICKS (${scanRes.scanned} match diaudit)</b>`);
  if (!topAnchors.length) {
    lines.push(`<i>Belum ada Tier 1–2 anchor yang lolos 12 Titanium Filter saat ini.</i>`);
  } else {
    topAnchors.forEach((p, idx) => {
      const oddsStr = p.bookmaker_odds
        ? `Fair ${p.fair_odds} | Bookie ${p.bookmaker_odds}${p.edge_pct !== null ? ` (${p.edge_pct > 0 ? "+" : ""}${p.edge_pct}% EV)` : ""}`
        : `Fair ${p.fair_odds}`;
      const xiTag = p.xi_confirmed ? "XI✓" : "Pre-XI";
      const newsLine = p.news_headline
        ? `\n   📰 [${escHtml((p.news_signals || ["NEWS"])[0])}] ${escHtml(p.news_headline.slice(0, 110))}`
        : "";
      lines.push(
        `\n<b>${idx + 1}. [${escHtml(p.league)}]</b> · <code>${escHtml(p.kickoff_dual)}</code>\n` +
        `   ${escHtml(p.home)} vs ${escHtml(p.away)} (Proj ${escHtml(p.projected_score)} · ${xiTag})\n` +
        `   🎯 <b>${escHtml(p.market)}</b> — <b>${p.model_prob}%</b>\n` +
        `   💰 ${escHtml(oddsStr)} · Stake <b>${p.stake_units}u</b>${newsLine}`
      );
    });
  }

  if (topCorners.length) {
    lines.push("");
    lines.push(`<b>🚩 BEST CORNERS (NegBin)</b>`);
    for (const c of topCorners) {
      lines.push(`• [${escHtml(c.league)}] ${escHtml(c.home)} vs ${escHtml(c.away)} → <b>${escHtml(c.market)}</b> (<b>${c.model_prob}%</b> · Fair ${c.fair_odds})`);
    }
  }

  if (topBtts.length) {
    lines.push("");
    lines.push(`<b>⚽ BEST BTTS</b>`);
    for (const b of topBtts) {
      lines.push(`• [${escHtml(b.league)}] ${escHtml(b.home)} vs ${escHtml(b.away)} → <b>${escHtml(b.market)}</b> (<b>${b.model_prob}%</b> · Fair ${b.fair_odds})`);
    }
  }

  const fp = analytics.weights.factor_penalties || {};
  lines.push("");
  lines.push(`<i>Neural: Goal×${analytics.weights.goal_lambda_scale} · Corner×${analytics.weights.corner_lambda_scale} · Pre-XI -${fp.pre_xi || 0} · AF ${backupObj.usage.api_football}/100 · News ${newsCalls}q</i>`);

  const msg = lines.join("\n");
  try { fs.writeFileSync(path.join(DATA_DIR, "last_report.txt"), msg); } catch {}
  let tgRes;
  try {
    tgRes = await sendTelegram(
      (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
      (process.env.TELEGRAM_CHAT_ID || "").trim(),
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
