// src/App.jsx
// Night Report Dashboard (React + Vite + Tailwind)
// - Overview: 8 fixed placeholders (252, 253, 260, 261, 262, 263, 265, 266)
//   * Click a card to open a modal with full defect details
//   * "Follow latest" auto-loads the newest saved report date
//   * History list shows past reports with who/when last saved
// - Generator: compose a Night Report from HOTO quick inputs + pasted Telegram defects
// - HOTO checker: paste HOTO, tick outstanding items, and save ticks with the report
//
// Storage: Firestore (collection "reports", doc id = "YYYY-MM-DD")
// Auth: Google (popup with redirect fallback handled in firebase.js)

import React, { useEffect, useMemo, useRef, useState } from "react";

import {
  db,
  auth,
  onAuthStateChanged,
  signInWithGoogleSmart,
  signOut,
  completeRedirectSignIn,
} from "./firebase";

import {
  collection,
  doc,
  setDoc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
  deleteDoc,
} from "firebase/firestore";

/* =========================
   Settings / constants
   ========================= */
const PLACEHOLDERS = [252, 253, 260, 261, 262, 263, 265, 266];
// Use \n (not /n) to create a newline; footer uses whitespace-pre-line to render it
const APP_VERSION = "v0.0.1\nCreated by JohnAturN";

/* =========================
   Helpers (IDs, status, parsing)
   ========================= */

// Convert numeric placeholder id to code:
// 252 -> F2 ; 253 -> F3 ; 260 -> S0 ; 261 -> S1 ; etc.
function idToCode(id) {
  if (id >= 251 && id <= 259) return `F${id - 250}`;
  if (id >= 260 && id <= 269) return `S${id - 260}`;
  return String(id);
}

// Determine status color/tag from the parsed entry.
// Priority: rectification (red) > in-phase (orange) > recovery (blue) > serviceable (green)
function deriveStatusTag(entry) {
  const title = entry.title.toLowerCase();
  const notes = entry.notes.join(" ").toLowerCase();

  const hasDefect =
    /\bdefect:/.test(title) ||
    /\bdefect:/.test(notes) ||
    /\brect:/.test(title) ||
    /\brect:/.test(notes) ||
    /\bgr\b/.test(title) ||
    /\bgr\b/.test(notes);

  const inPhase = /(major serv|phase\b)/.test(title); // header-only
  const recovery =
    /(post phase rcv|recovery)/.test(title) ||
    /(post phase rcv|recovery)/.test(notes);

  if (hasDefect) return "rectification";
  if (inPhase) return "in-phase";
  if (recovery) return "recovery";
  if (/\s-\s*s(\b|$)/i.test(entry.title)) return "serviceable";
  return "serviceable";
}

// Map status tag to Tailwind classes
function statusToClasses(tag) {
  switch (tag) {
    case "serviceable":
      return "bg-green-50 border-green-300";
    case "rectification":
      return "bg-red-50 border-red-300";
    case "in-phase":
      return "bg-orange-50 border-orange-300";
    case "recovery":
      return "bg-blue-50 border-blue-300";
    default:
      return "bg-gray-50 border-gray-200";
  }
}

// Parse Night Report source text into a map keyed by code ("S1", "F2", ...)
function parseReport(text) {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim());
  const entries = {};
  let current = null;

  // Headers like "*S2 - GR", "S0  - Major Serv (...)", "*F2 - S"
  const header = /^[>*\s-]*\*?\s*([SF]\d)\s*-\s*(.+)$/i;

  for (const line of lines) {
    if (!line) continue;

    const h = header.exec(line);
    if (h) {
      const code = h[1].toUpperCase();
      const tail = h[2].trim();
      entries[code] = {
        code,
        title: `${code} - ${tail}`,
        input: "",
        etr: "",
        notes: [],
      };
      current = code;
      continue;
    }

    if (!current) continue;

    // Known fields
    const mInput = /^Input:\s*(.+)$/i.exec(line);
    if (mInput) {
      entries[current].input = mInput[1].trim();
      continue;
    }
    const mEtr = /^ETR:\s*(.+)$/i.exec(line);
    if (mEtr) {
      entries[current].etr = mEtr[1].trim();
      continue;
    }

    // Bulleted notes or "Requirements" marker
    if (/^>/.test(line)) {
      entries[current].notes.push(line.replace(/^>\s*/, ""));
      continue;
    }
    if (/^-/.test(line)) {
      entries[current].notes.push(line.replace(/^-+\s*/, ""));
      continue;
    }
    if (/^Requirements$/i.test(line)) {
      entries[current].notes.push("Requirements:");
      continue;
    }
  }

  // Attach status tag
  Object.keys(entries).forEach((k) => {
    entries[k].tag = deriveStatusTag(entries[k]);
  });

  return entries;
}

// Utilities for date formatting
function getTodayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatDayHeader(iso) {
  try {
    const d = new Date(`${iso}T00:00:00`);
    const day = d.getDate();
    const mon = d.toLocaleString(undefined, { month: "short" });
    const wk = d.toLocaleString(undefined, { weekday: "short" });
    return `${day} ${mon} (${wk})`;
  } catch {
    return iso;
  }
}

/* =========================
   Telegram defects parsing
   ========================= */
// Parses pasted Telegram message(s) into a per-code object to help build the report.
function parseTelegramDefects(text) {
  const blocks = text
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const byCode = {};
  let current = null;
  const pushCurrent = () => { if (current && current.code) byCode[current.code] = current; };

  for (const b of blocks) {
    // Identify a block with just "S3" or "F2" etc.
    const codeLine = b.match(/^\s*([FS]\d)\s*$/im);
    if (codeLine) { pushCurrent(); current = { code: codeLine[1].toUpperCase(), lines: [] }; }
    if (!current) continue;
    current.lines.push(b);
  }
  pushCurrent();

  // Extract fields from combined text per code
  Object.values(byCode).forEach((rec) => {
    const all = rec.lines.join("\n\n");
    const get = (re) => (all.match(re)?.[1] || "").trim();

    rec.us = get(/Date\/Time\s*[‘'"]?U\/S[’'"]?\s*:\s*([^\n]+)/i);
    rec.defect = get(/\bDefect:\s*([\s\S]*?)(?:\n{1,2}[A-Z][a-z]+:|\n{2,}|$)/i);
    rec.rect = get(/\bRect:\s*([^\n]+)/i);
    rec.etr = get(/\bETR:\s*([^\n]+)/i);

    rec.recovery = /(^|\n)\s*Recovery\s*$/i.test(all) || /post\s*phase\s*rcv/i.test(all);

    rec.gr = [];
    const grMatch = all.match(/G\/?run requirement:\s*([\s\S]*?)(?:\n{2,}|FCF requirement:|Workcenter:|$)/i);
    if (grMatch) {
      rec.gr.push(
        ...grMatch[1].split("\n").map((l) => l.replace(/^\s*[-•]\s*/, "").trim()).filter(Boolean)
      );
    }

    rec.fcf = [];
    const fcfMatch = all.match(/FCF requirement:\s*([\s\S]*?)(?:\n{2,}|G\/?run requirement:|Workcenter:|$)/i);
    if (fcfMatch) {
      rec.fcf.push(
        ...fcfMatch[1].split("\n").map((l) => l.replace(/^\s*[-•]\s*/, "").trim()).filter(Boolean)
      );
    }

    rec.workcenter = get(/Workcenter:\s*([^\n]+)/i);
    rec.prime = get(/Prime Trade:\s*([^\n]+)/i);
    rec.system = get(/System:\s*([^\n]+)/i);
  });

  return byCode;
}

/* =========================
   HOTO parsing
   ========================= */
// Splits HOTO text into: Job Completed, Outstanding (with tickable items), and extra sections.
function parseHOTO(text) {
  const out = {
    completed: {},    // { code: [ "BFS done", ... ] }
    outstanding: {},  // { code: { tag: "(MC) <...>", items: [ "...", "> sub ..." ] } }
    extra: {
      proj14: [],
      proj28: [],
      proj56: [],
      proj112: [],
      proj112150: [],
      proj180: [],
      mee: [],
      eoss: [],
      bru: [],
      probe: [],
      aom: [],
      lessons: [],
    },
  };

  const lines = text.replace(/\r/g, "").split("\n");
  let section = null;           // 'completed' | 'outstanding' | 'proj14' | ...
  let currentCode = null;

  const isMajorHeader = (s) => /^([•■●])\s/.test(s) || /^🟩|^🟥/.test(s);

  const startSection = (line) => {
    if (/🟩\s*Job Completed/i.test(line)) { section = "completed"; currentCode = null; return true; }
    if (/🟥\s*Outstanding/i.test(line)) { section = "outstanding"; currentCode = null; return true; }
    if (/^•\s*14D\s*SERV\s*PROJECTION/i.test(line)) { section = "proj14"; return true; }
    if (/^•\s*28D\s*SERV\s*PROJECTION/i.test(line)) { section = "proj28"; return true; }
    if (/^•\s*56D\s*SERV\s*PROJECTION/i.test(line)) { section = "proj56"; return true; }
    if (/^•\s*112D\/150H?rl?y\s*PROJECTION/i.test(line)) { section = "proj112150"; return true; }
    if (/^•\s*112D\s*SERV\s*PROJECTION/i.test(line)) { section = "proj112"; return true; }
    if (/^•\s*180D\s*SERV\s*PROJECTION/i.test(line)) { section = "proj180"; return true; }
    if (/^■\s*MEE/i.test(line)) { section = "mee"; return true; }
    if (/^■\s*EOSS\s*Status/i.test(line)) { section = "eoss"; return true; }
    if (/^■\s*BRU\s*Status/i.test(line)) { section = "bru"; return true; }
    if (/^■\s*Probe\s*Status/i.test(line)) { section = "probe"; return true; }
    if (/^●\s*AOM/i.test(line)) { section = "aom"; return true; }
    if (/^●\s*Lesson learnt/i.test(line)) { section = "lessons"; return true; }
    return false;
  };

  // Iterate through lines
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // New section?
    if (isMajorHeader(line)) {
      startSection(line);
      continue;
    }

    if (section === "completed" || section === "outstanding") {
      // Detect "S3 (MC) ..." or "F2 ..." lines → set current code
      const mCode = line.match(/^([FS]\d)(?:\s*\(([^)]+)\))?.*$/i);
      if (mCode) {
        currentCode = mCode[1].toUpperCase();
        if (section === "completed") {
          if (!out.completed[currentCode]) out.completed[currentCode] = [];
        } else {
          if (!out.outstanding[currentCode]) out.outstanding[currentCode] = { tag: "", items: [] };
          out.outstanding[currentCode].tag = mCode[2]?.trim() || out.outstanding[currentCode].tag || "";
        }
        continue;
      }

      // Lines beginning with -, •, or > are items under the current code
      if (/^[-•>]/.test(line) && currentCode) {
        const clean = line.replace(/^[-•]\s*/, "").trim();
        const keep = clean.replace(/^>\s*/, "> ");
        if (section === "completed") out.completed[currentCode].push(keep);
        else out.outstanding[currentCode].items.push(keep);
        continue;
      }

      // Any other line after a code belongs to that code's list
      if (currentCode) {
        if (section === "completed") out.completed[currentCode].push(line);
        else out.outstanding[currentCode].items.push(line);
        continue;
      }
    } else if (section && section in out.extra) {
      // Extra sections: collect raw lines (strip bullets/arrows)
      const clean = line.replace(/^[-•]\s*/, "").replace(/^>\s*/, "").trim();
      out.extra[section].push(clean);
    }
  }

  return out;
}

/* =========================
   App
   ========================= */
export default function App() {
  // ========== Top-level UI state ==========
  // Modal for clicking a card in Overview
  const [detail, setDetail] = useState(null); // { id, code, entry } | null

  // Complete redirect-based sign-in (e.g., Safari PWA)
  useEffect(() => {
    completeRedirectSignIn();
  }, []);

  // Firebase Auth state (Google)
  const [user, setUser] = useState(null);
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  // Tabs: 'overview' | 'generator' | 'hoto'
  const [tab, setTab] = useState("overview");

  // Date + report editor text
  const [selectedDate, setSelectedDate] = useState(getTodayISO());
  const [reportTitle, setReportTitle] = useState("Night Report");
  const [raw, setRaw] = useState(""); // this drives Overview parsing

  // Auto-jump to newest date in history
  const [followLatest, setFollowLatest] = useState(true);

  // Generator inputs (for composing Night Report)
  const [genSBirds, setGenSBirds] = useState("F2, F3, S3, S5, S6");
  const [genFishing, setGenFishing] = useState("Nil");
  const [genHealing, setGenHealing] = useState("Nil");
  const [tgText, setTgText] = useState("");

  // HOTO checker
  const [hotoRaw, setHotoRaw] = useState("");
  const hoto = useMemo(() => parseHOTO(hotoRaw), [hotoRaw]);
  const [hotoTicks, setHotoTicks] = useState({}); // key `${code}|${text}` -> boolean
  function toggleTick(code, text) {
    const key = `${code}|${text}`;
    setHotoTicks((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // ========== Firestore live data ==========
  // History list (array of { id, updatedAt, savedBy, title })
  const [cloudDates, setCloudDates] = useState([]);
  const docUnsubRef = useRef(null); // per-doc listener cleanup

  // Listen to collection of reports; keep newest first; optionally auto-follow newest
  useEffect(() => {
    const qy = query(collection(db, "reports"), orderBy("__name__"));
    const unsub = onSnapshot(qy, (snap) => {
      const docs = [];
      snap.forEach((d) => {
        const data = d.data() || {};
        docs.push({
          id: d.id,                                   // "YYYY-MM-DD"
          updatedAt: data.updatedAt?.toDate?.() || null,
          savedBy: data.savedBy || null,
          title: data.title || null,
        });
      });

      docs.sort((a, b) => b.id.localeCompare(a.id)); // newest first
      setCloudDates(docs);

      if (docs.length) {
        const newestId = docs[0].id;
        const hasSelected = docs.some((x) => x.id === selectedDate);
        // Follow newest automatically, or recover if selected date was deleted
        if (followLatest && selectedDate !== newestId) {
          loadCloudDate(newestId);
        } else if (!hasSelected) {
          loadCloudDate(newestId);
        }
      }
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followLatest, selectedDate]);

  // Cleanup the per-doc subscription when the component unmounts
  useEffect(() => {
    return () => {
      if (docUnsubRef.current) docUnsubRef.current();
    };
  }, []);

  // Subscribe live to a single day's document
  function loadCloudDate(date) {
    if (!date) return;
    setSelectedDate(date);
    if (docUnsubRef.current) docUnsubRef.current();
    const dref = doc(db, "reports", date);
    docUnsubRef.current = onSnapshot(
      dref,
      (snap) => {
        const data = snap.data();
        if (data) {
          setReportTitle(data.title || "Night Report");
          setRaw(data.raw || "");
          setHotoRaw(data.hotoRaw || "");
          setHotoTicks(data.hotoTicks || {});
        } else {
          // New/empty date
          setReportTitle("Night Report");
          setRaw("");
          setHotoRaw("");
          setHotoTicks({});
        }
      },
      (err) => {
        console.error("Subscribe error:", err);
      }
    );
  }

  // Save the current report (requires whitelisted Google email per your Firestore Rules)
  async function handleSave() {
    if (!user) {
      alert("Please sign in with Google to save.");
      return;
    }
    try {
      await setDoc(doc(db, "reports", selectedDate), {
        title: reportTitle || "Night Report",
        raw,
        hotoRaw,
        hotoTicks,
        updatedAt: serverTimestamp(),
        savedBy: user?.email || null,   // who saved
      });
      alert(`Saved cloud report for ${selectedDate}.`);
    } catch (e) {
      console.error(e);
      alert(
        `Save failed. Reason: ${e?.code || "permission-denied"}\n` +
          `Make sure you're signed in with a whitelisted email in Firestore Rules.`
      );
    }
  }

  // Delete an existing date's document
  async function handleDeleteDate(date) {
    if (!user) {
      alert("Please sign in with Google to delete.");
      return;
    }
    if (!date) return;
    if (!confirm(`Delete cloud report for ${date}?`)) return;
    try {
      await deleteDoc(doc(db, "reports", date));
    } catch (e) {
      console.error(e);
      alert("Delete failed (check Firestore rules/whitelist).");
    }
  }

  // Generate Night Report text from HOTO quick inputs + Telegram defects
  function handleGenerate() {
    const defectMap = parseTelegramDefects(tgText || "");

    // Parse list like "F2, F3, S3, S5, S6"
    const sCodes = Array.from(
      new Set(
        (genSBirds || "")
          .split(/[,\s]+/)
          .map((c) => c.trim().toUpperCase())
          .filter((c) => /^[FS]\d$/.test(c))
      )
    );
    const sCount = sCodes.length;

    const lines = [];
    lines.push(`Night Report for ${formatDayHeader(selectedDate)}`);
    lines.push("");
    lines.push(`${sCount} x ‘S’ Bird`);
    lines.push(sCodes.join(", ") || "—");
    lines.push("");
    lines.push("Fishing 🎣");
    lines.push(genFishing || "Nil");
    lines.push("");
    lines.push("Healing ❤️‍🩹");
    lines.push(genHealing || "Nil");
    lines.push("");
    lines.push("Status 🚁");
    lines.push("(* denotes fitted with 'S' EOSS TU)");
    lines.push("(^ denotes fitted with ‘U/S’  EOSS TU)");
    lines.push("");

    // Add blocks for any codes present in Telegram defects
    const defectCodes = Object.keys(defectMap).sort();
    defectCodes.forEach((code, idx) => {
      const d = defectMap[code];
      lines.push(`*${code} - GR`);
      if (d.us) lines.push(`Input: ${d.us}`);
      if (d.etr) lines.push(`ETR: ${d.etr}`);
      lines.push("");
      if (d.defect) lines.push(`- Defect: ${d.defect}`);
      if (d.rect) lines.push(`> Rect: ${d.rect}`);
      if (d.recovery) { lines.push("> Post phase rcv"); lines.push(""); }
      if (d.gr?.length) {
        lines.push("Requirements"); lines.push("- G/R");
        d.gr.forEach((g) => lines.push(`> ${g}`));
      }
      if (d.fcf?.length) {
        if (!d.gr?.length) lines.push("Requirements");
        lines.push("- FCF");
        d.fcf.forEach((f) => lines.push(`> ${f}`));
      }
      if (idx < defectCodes.length - 1) lines.push("");
    });

    if (defectCodes.length) lines.push("");

    // Any codes that were not in defects list are just serviceable
    sCodes.filter((c) => !defectMap[c]).forEach((code) => {
      lines.push(`*${code} - S`);
      lines.push("");
    });

    setRaw(lines.join("\n"));
    setTab("overview"); // Show the result in Overview immediately
  }

  // Copy Night Report source text to clipboard
  function copyReport() {
    if (!raw) return;
    navigator.clipboard?.writeText(raw).then(
      () => alert("Report copied to clipboard."),
      () => alert("Could not copy (clipboard blocked).")
    );
  }

  // ========== Derived UI state for Overview ==========
  const parsed = useMemo(() => parseReport(raw), [raw]);

  // Turn fixed placeholder ids into cards rendered left→right
  const cards = useMemo(() => {
    return PLACEHOLDERS.map((id) => {
      const code = idToCode(id);
      const entry = parsed[code];
      return { id, code, entry };
    });
  }, [parsed]);

  // Helper to show a short preview line (first defect line if available)
  function firstDefectLine(entry) {
    if (!entry) return "";
    const inTitle = (entry.title.match(/defect:\s*(.*)/i) || [])[1];
    if (inTitle) return inTitle.trim();
    const note = entry.notes.find((n) => /^defect:/i.test(n));
    if (note) return note.replace(/^defect:\s*/i, "").trim();
    return entry.title.split(" - ").slice(1).join(" - "); // fallback: header tail
  }

  // ========== Render ==========
  return (
    <div className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto">
      {/* Top bar: title + auth */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold">Night Report Dashboard</h1>
          <p className="text-sm text-gray-600">
            8 placeholders: 252, 253, 260, 261, 262, 263, 265, 266. Mapping: F → 25x, S → 26x
            (e.g., F2→252, F3→253, S1→261).
          </p>
        </div>
        <div className="flex items-center gap-2">
          {user ? (
            <>
              <span className="text-sm text-gray-600">Signed in as {user.email}</span>
              <button className="border rounded px-3 py-2 text-sm" onClick={() => signOut(auth)}>
                Sign out
              </button>
            </>
          ) : (
            <button className="border rounded px-3 py-2 text-sm" onClick={signInWithGoogleSmart}>
              Sign in with Google to edit
            </button>
          )}
        </div>
      </div>

      {/* Tabs (Overview / Generator / HOTO) */}
      <nav className="mb-6 border-b">
        <ul className="flex gap-2">
          {[
            ["overview", "Overview"],
            ["generator", "Night report generator"],
            ["hoto", "HOTO checker"],
          ].map(([key, label]) => (
            <li key={key}>
              <button
                className={`px-3 py-2 text-sm border-b-2 ${
                  tab === key ? "border-blue-600 text-blue-700" : "border-transparent text-gray-600"
                }`}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Global controls (date/title/save) */}
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-3">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 md:gap-3">
          {/* Pick a date; picking turns off followLatest so you can browse history */}
          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Report date</span>
            <input
              type="date"
              className="border rounded px-3 py-2 text-sm w-full"
              value={selectedDate}
              onChange={(e) => {
                setFollowLatest(false);
                loadCloudDate(e.target.value);
              }}
            />
          </label>

          {/* Title field */}
          <label className="text-sm md:col-span-2">
            <span className="block text-gray-700 mb-1">Title</span>
            <input
              type="text"
              className="border rounded px-3 py-2 text-sm w-full"
              value={reportTitle}
              onChange={(e) => setReportTitle(e.target.value)}
              placeholder="Night Report"
            />
          </label>

          {/* Follow latest toggle */}
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={followLatest}
              onChange={(e) => setFollowLatest(e.target.checked)}
            />
            Follow latest
          </label>

          {/* Save button */}
          <div className="flex flex-wrap gap-2 md:col-span-4">
            <button
              className={`border rounded px-3 py-2 text-sm text-white ${
                user ? "bg-blue-600" : "bg-gray-400 cursor-not-allowed"
              }`}
              onClick={handleSave}
              disabled={!user}
              title="Saves Night Report + HOTO + ticks to cloud"
            >
              Save to cloud
            </button>
            <span className="text-xs text-gray-500 self-center">
              {user ? "You can edit & save." : "Sign in to save changes."}
            </span>
          </div>
        </div>
      </header>

      {/* History list of saved reports */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">
          Saved reports (cloud)
          {followLatest && (
            <span className="ml-2 text-xs text-blue-700">(following latest)</span>
          )}
        </h2>

        {cloudDates.length === 0 ? (
          <div className="text-sm text-gray-500">No cloud reports yet.</div>
        ) : (
          <ul className="border rounded divide-y">
            {cloudDates.map((d) => (
              <li
                key={d.id}
                className={`p-2 text-sm ${d.id === selectedDate ? "bg-gray-50" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    className="underline text-blue-700 text-left"
                    onClick={() => {
                      setFollowLatest(false);   // pin to this specific date
                      loadCloudDate(d.id);
                    }}
                    title="Load this date"
                  >
                    {d.id}
                  </button>
                  <button
                    className={`${user ? "text-red-700" : "text-gray-400 cursor-not-allowed"}`}
                    onClick={() => handleDeleteDate(d.id)}
                    disabled={!user}
                    title="Delete this date"
                  >
                    Delete
                  </button>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {d.updatedAt ? d.updatedAt.toLocaleString() : "—"}
                  {d.savedBy ? ` • ${d.savedBy}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Tab content */}
      {tab === "overview" && (
        <>
          {/* Cards grid (click a card to open modal with full details) */}
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {cards.map(({ id, code, entry }) => {
              const tag = entry?.tag || "none";
              const classes = entry ? statusToClasses(tag) : "bg-gray-50 border-gray-200";

              // Short preview line for the card body
              const short = entry ? firstDefectLine(entry) : "";

              const clickable = !!entry;

              return (
                <div
                  key={id}
                  className={`border rounded-2xl p-4 shadow-sm ${classes} ${
                    clickable ? "cursor-pointer hover:shadow" : "opacity-70"
                  }`}
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : -1}
                  onClick={() => clickable && setDetail({ id, code, entry })}
                  onKeyDown={(e) => {
                    if (!clickable) return;
                    if (e.key === "Enter" || e.key === " ") setDetail({ id, code, entry });
                  }}
                  title={clickable ? "Click to view full details" : "No data for this tail"}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="font-semibold text-lg">{id}</div>
                    <div className="text-xs px-2 py-0.5 rounded bg-white border">{code}</div>
                  </div>
                  <div className="text-xs text-gray-500 mb-2">
                    {reportTitle} — {selectedDate}
                  </div>
                  {entry ? (
                    <>
                      <div className="text-sm font-medium mb-1">{entry.title}</div>
                      <div className="flex flex-wrap gap-2 text-xs mb-2">
                        {entry.input && (
                          <span className="px-2 py-0.5 bg-white border rounded">Input: {entry.input}</span>
                        )}
                        {entry.etr && (
                          <span className="px-2 py-0.5 bg-white border rounded">ETR: {entry.etr}</span>
                        )}
                        <span className="px-2 py-0.5 bg-white border rounded">
                          {tag === "serviceable" && "Serviceable"}
                          {tag === "rectification" && "Rectification"}
                          {tag === "in-phase" && "In Phase"}
                          {tag === "recovery" && "Recovery"}
                          {tag === "none" && "No status"}
                        </span>
                      </div>

                      {/* Preview (full details in modal) */}
                      <div className="text-sm">{short}</div>
                    </>
                  ) : (
                    <div className="italic text-sm text-gray-500">No data for {code}.</div>
                  )}
                </div>
              );
            })}
          </section>

          {/* Night Report source editor (you can paste or modify text directly) */}
          <section className="mt-6">
            <h3 className="text-md font-semibold mb-2">Night Report text (source)</h3>
            <textarea
              className="w-full min-h-[240px] border rounded p-3"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="Paste or generate your Night Report here…"
            />
            <div className="mt-2 flex gap-2">
              <button className="border rounded px-3 py-2 text-sm" onClick={copyReport} disabled={!raw}>
                Copy Night Report
              </button>
            </div>
          </section>

          {/* Modal with full details when a card is clicked */}
          {detail && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
              onClick={() => setDetail(null)}
            >
              <div
                className="w-full max-w-2xl bg-white rounded-2xl shadow-xl border overflow-hidden"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
              >
                <div className="flex items-center justify-between px-4 py-3 border-b">
                  <div className="font-semibold">
                    Tail {detail.id} &nbsp; <span className="text-gray-500">({detail.code})</span>
                  </div>
                  <button className="text-sm px-2 py-1 border rounded" onClick={() => setDetail(null)}>
                    Close
                  </button>
                </div>

                <div className="p-4 space-y-3">
                  <div className="text-sm text-gray-500">
                    {reportTitle} — {selectedDate}
                  </div>

                  <div className="text-base font-medium">{detail.entry.title}</div>

                  <div className="flex flex-wrap gap-2 text-xs">
                    {detail.entry.input && (
                      <span className="px-2 py-0.5 bg-gray-50 border rounded">Input: {detail.entry.input}</span>
                    )}
                    {detail.entry.etr && (
                      <span className="px-2 py-0.5 bg-gray-50 border rounded">ETR: {detail.entry.etr}</span>
                    )}
                  </div>

                  {/* Full notes list */}
                  {detail.entry.notes?.length ? (
                    <ul className="list-disc pl-5 text-sm space-y-1">
                      {detail.entry.notes.map((n, i) => (
                        <li key={i} className="whitespace-pre-wrap">{n}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-sm text-gray-500">No additional notes.</div>
                  )}

                  {/* Copy details button */}
                  <div className="pt-2">
                    <button
                      className="text-sm px-3 py-2 border rounded"
                      onClick={() => {
                        const e = detail.entry;
                        const lines = [];
                        lines.push(`${e.title}`);
                        if (e.input) lines.push(`Input: ${e.input}`);
                        if (e.etr) lines.push(`ETR: ${e.etr}`);
                        if (e.notes?.length) {
                          lines.push("");
                          e.notes.forEach((ln) => lines.push(ln));
                        }
                        const blob = lines.join("\n");
                        navigator.clipboard?.writeText(blob).then(
                          () => alert("Details copied"),
                          () => alert("Could not copy (clipboard blocked)")
                        );
                      }}
                    >
                      Copy details
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {tab === "generator" && (
        <>
          {/* Night Report Generator */}
          <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
            <div className="lg:col-span-1">
              <h2 className="text-lg font-semibold mb-2">HOTO (quick inputs for Report)</h2>

              {/* Comma-separated list of S birds (codes like F2, S3, etc.) */}
              <label className="text-sm block mb-2">
                <span className="block text-gray-700 mb-1">Serviceable birds (comma-separated)</span>
                <input
                  className="w-full border rounded p-2 text-sm"
                  value={genSBirds}
                  onChange={(e) => setGenSBirds(e.target.value)}
                  placeholder="F2, F3, S3, S5, S6"
                />
              </label>

              {/* Fishing text line */}
              <label className="text-sm block mb-2">
                <span className="block text-gray-700 mb-1">Fishing 🎣</span>
                <input
                  className="w-full border rounded p-2 text-sm"
                  value={genFishing}
                  onChange={(e) => setGenFishing(e.target.value)}
                  placeholder="Nil"
                />
              </label>

              {/* Healing text line */}
              <label className="text-sm block">
                <span className="block text-gray-700 mb-1">Healing ❤️‍🩹</span>
                <input
                  className="w-full border rounded p-2 text-sm"
                  value={genHealing}
                  onChange={(e) => setGenHealing(e.target.value)}
                  placeholder="Nil"
                />
              </label>

              {/* Generate button */}
              <button
                className="mt-3 border rounded px-3 py-2 text-sm bg-emerald-600 text-white"
                onClick={handleGenerate}
              >
                Generate Night Report from HOTO + Telegram
              </button>
              <p className="text-xs text-gray-500 mt-2">
                Generates the Night Report and places it in the source editor.
              </p>
            </div>

            {/* Paste Telegram defects */}
            <div className="lg:col-span-2">
              <h2 className="text-lg font-semibold mb-2">Paste Telegram defects</h2>
              <textarea
                className="w-full min-h-[260px] border rounded p-3"
                value={tgText}
                onChange={(e) => setTgText(e.target.value)}
                placeholder="Paste Telegram defect updates here…"
              />
            </div>
          </section>

          {/* Source editor (for final Night Report text) */}
          <section>
            <h3 className="text-md font-semibold mb-2">Night Report text (source)</h3>
            <textarea
              className="w-full min-h-[280px] border rounded p-3"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="Paste or generate your Night Report here…"
            />
            <div className="mt-2 flex gap-2">
              <button className="border rounded px-3 py-2 text-sm" onClick={copyReport} disabled={!raw}>
                Copy Night Report
              </button>
              <button
                className="border rounded px-3 py-2 text-sm"
                onClick={() => setTab("overview")}
              >
                View in Overview
              </button>
            </div>
          </section>
        </>
      )}

      {tab === "hoto" && (
        <>
          {/* HOTO Checker */}
          <section className="mb-8">
            <h2 className="text-xl font-semibold mb-3">HOTO Checker</h2>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Paste HOTO */}
              <div className="lg:col-span-1">
                <label className="text-sm block mb-2">
                  <span className="block text-gray-700 mb-1">Paste HOTO text</span>
                  <textarea
                    className="w-full min-h-[280px] border rounded p-3"
                    value={hotoRaw}
                    onChange={(e) => setHotoRaw(e.target.value)}
                    placeholder="Paste HOTO (e.g., 08/08 PM HOTO) here…"
                  />
                </label>
                <p className="text-xs text-gray-500">
                  Ticks on Outstanding are saved with the “Save to cloud” button.
                </p>
              </div>

              {/* Completed + Outstanding with tickboxes */}
              <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Completed */}
                <div className="border rounded-2xl p-4 bg-green-50 border-green-300">
                  <div className="font-semibold mb-2">🟩 Job Completed</div>
                  {Object.keys(hoto.completed).length === 0 ? (
                    <div className="text-sm text-gray-500">No completed items.</div>
                  ) : (
                    Object.keys(hoto.completed).sort().map((code) => (
                      <div key={code} className="mb-3">
                        <div className="font-medium">{code}</div>
                        <ul className="list-disc pl-5 text-sm space-y-1 mt-1">
                          {hoto.completed[code].map((t, i) => (
                            <li key={i}>{t.startsWith("> ") ? <span className="ml-2">{t.slice(2)}</span> : t}</li>
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                </div>

                {/* Outstanding */}
                <div className="border rounded-2xl p-4 bg-red-50 border-red-300">
                  <div className="font-semibold mb-2">🟥 Outstanding</div>
                  {Object.keys(hoto.outstanding).length === 0 ? (
                    <div className="text-sm text-gray-500">No outstanding items.</div>
                  ) : (
                    Object.keys(hoto.outstanding).sort().map((code) => {
                      const group = hoto.outstanding[code];
                      return (
                        <div key={code} className="mb-3">
                          <div className="font-medium">
                            {code} {group.tag ? <span className="text-xs text-gray-600">({group.tag})</span> : null}
                          </div>
                          <div className="flex flex-col gap-1 mt-1">
                            {group.items.map((t, i) => {
                              const key = `${code}|${t}`;
                              const done = !!hotoTicks[key];
                              return (
                                <label key={i} className="flex items-start gap-2 text-sm">
                                  <input
                                    type="checkbox"
                                    className="mt-0.5"
                                    checked={done}
                                    onChange={() => toggleTick(code, t)}
                                    title="Mark done (tick is saved with Save button)"
                                  />
                                  <span className={done ? "line-through text-gray-500" : ""}>
                                    {t.startsWith("> ") ? <span className="ml-4">{t.slice(2)}</span> : t}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* Extras from HOTO */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
              {[
                ["proj14", "• 14D SERV PROJECTION"],
                ["proj28", "• 28D SERV PROJECTION"],
                ["proj56", "• 56D SERV PROJECTION"],
                ["proj112", "• 112D SERV PROJECTION"],
                ["proj112150", "• 112D/150Hrly PROJECTION"],
                ["proj180", "• 180D SERV PROJECTION"],
                ["eoss", "■ EOSS Status"],
                ["mee", "■ MEE"],
                ["bru", "■ BRU Status"],
                ["probe", "■ Probe Status"],
                ["aom", "● AOM"],
                ["lessons", "● Lesson learnt"],
              ].map(([key, title]) => (
                <div key={key} className="border rounded-2xl p-4">
                  <div className="font-semibold mb-2">{title}</div>
                  {hoto.extra[key]?.length ? (
                    <ul className="list-disc pl-5 text-sm space-y-1">
                      {hoto.extra[key].map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-sm text-gray-500">—</div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {/* Footer: shows version on first line, author on next line */}
      <footer className="mt-10 text-center text-xs text-gray-500 whitespace-pre-line">
        Version {APP_VERSION}
      </footer>
    </div>
  );
}
