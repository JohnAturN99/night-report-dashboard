import React, { useEffect, useMemo, useState } from "react";

/* =========================
   Settings / constants
   ========================= */
const PLACEHOLDERS = [252, 253, 260, 261, 262, 263, 265, 266];
const STORAGE_KEY = "nr_reports_v1"; // localStorage key

/* =========================
   Helpers
   ========================= */
function idToCode(id) {
  if (id >= 251 && id <= 259) return `F${id - 250}`; // 252->F2, 253->F3
  if (id >= 260 && id <= 269) return `S${id - 260}`; // 260->S0, 261->S1, ...
  return String(id);
}

// derive status tag by keywords with fixed priority
function deriveStatusTag(entry) {
  const title = entry.title.toLowerCase();
  const notes = entry.notes.join(" ").toLowerCase();

  // Rectification if defects/GR appear anywhere
  const hasDefect =
    /\bdefect:/.test(title) ||
    /\bdefect:/.test(notes) ||
    /\bgr\b/.test(title) ||
    /\bgr\b/.test(notes);

  // In-phase ONLY if the HEADER mentions Major Serv or Phase
  const inPhase = /(major serv|phase\b)/.test(title);

  // Recovery if noted in header or notes
  const recovery =
    /(post phase rcv|recovery)/.test(title) ||
    /(post phase rcv|recovery)/.test(notes);

  // Priority: Red > Orange > Blue > Green
  if (hasDefect) return "rectification";
  if (inPhase) return "in-phase";
  if (recovery) return "recovery";

  // Explicit "- S" in header or default to serviceable
  if (/\s-\s*s(\b|$)/i.test(entry.title)) return "serviceable";
  return "serviceable";
}

function statusToClasses(tag) {
  switch (tag) {
    case "serviceable":   return "bg-green-50 border-green-300";
    case "rectification": return "bg-red-50 border-red-300";
    case "in-phase":      return "bg-orange-50 border-orange-300";
    case "recovery":      return "bg-blue-50 border-blue-300";
    default:              return "bg-gray-50 border-gray-200";
  }
}

// Parse the pasted report into a map of entries by code (S1, F2, etc.)
function parseReport(text) {
  const lines = text.replace(/\r/g, "").split("\n").map(l => l.trim());
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
      entries[code] = { code, title: `${code} - ${tail}`, input: "", etr: "", notes: [] };
      current = code;
      continue;
    }

    if (!current) continue;

    const mInput = /^Input:\s*(.+)$/i.exec(line);
    if (mInput) { entries[current].input = mInput[1].trim(); continue; }

    const mEtr = /^ETR:\s*(.+)$/i.exec(line);
    if (mEtr) { entries[current].etr = mEtr[1].trim(); continue; }

    if (/^>/.test(line)) { entries[current].notes.push(line.replace(/^>\s*/, "")); continue; }
    if (/^-/.test(line)) { entries[current].notes.push(line.replace(/^-+\s*/, "")); continue; }
    if (/^Requirements$/i.test(line)) { entries[current].notes.push("Requirements:"); continue; }
  }

  // attach status tag
  Object.keys(entries).forEach(k => {
    entries[k].tag = deriveStatusTag(entries[k]);
  });

  return entries;
}

// localStorage helpers
function loadAllReports() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function saveAllReports(obj) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
}

/* =========================
   App
   ========================= */
export default function App() {
  // UI state
  const [selectedDate, setSelectedDate] = useState(getTodayISO()); // yyyy-mm-dd
  const [reportTitle, setReportTitle] = useState("Night Report");
  const [raw, setRaw] = useState(""); // pasted text
  const [reports, setReports] = useState({}); // { "2025-08-08": { title, raw, savedAt }, ... }

  // Load existing saved reports once
  useEffect(() => {
    const data = loadAllReports();
    setReports(data);
    const dates = Object.keys(data).sort();
    if (dates.length) {
      const latest = dates[dates.length - 1];
      setSelectedDate(latest);
      setReportTitle(data[latest]?.title || "Night Report");
      setRaw(data[latest]?.raw || "");
    } else {
      setRaw(DEFAULT_SAMPLE);
      setReportTitle("Night Report");
    }
  }, []);

  // Parsed entries for current raw
  const parsed = useMemo(() => parseReport(raw), [raw]);

  // Cards in the fixed placeholder order
  const cards = useMemo(() => {
    return PLACEHOLDERS.map((id) => {
      const code = idToCode(id);
      const entry = parsed[code];
      return { id, code, entry };
    });
  }, [parsed]);

  // Saved dates list (sorted newest first)
  const savedDates = useMemo(() => Object.keys(reports).sort().reverse(), [reports]);

  // Actions
  function handleSave() {
    if (!selectedDate) {
      alert("Please pick a date to save.");
      return;
    }
    const next = {
      ...reports,
      [selectedDate]: {
        title: reportTitle || "Night Report",
        raw,
        savedAt: new Date().toISOString(),
      },
    };
    setReports(next);
    saveAllReports(next);
  }

  function handleLoadDate(date) {
    if (!date) return;
    setSelectedDate(date);
    const rec = reports[date];
    if (rec) {
      setReportTitle(rec.title || "Night Report");
      setRaw(rec.raw || "");
    } else {
      setReportTitle("Night Report");
      setRaw("");
    }
  }

  function handleDeleteDate(date) {
    if (!date || !reports[date]) return;
    if (!confirm(`Delete saved report for ${date}?`)) return;
    const next = { ...reports };
    delete next[date];
    setReports(next);
    saveAllReports(next);
    const remain = Object.keys(next).sort();
    if (remain.length) {
      const latest = remain[remain.length - 1];
      setSelectedDate(latest);
      setReportTitle(next[latest]?.title || "Night Report");
      setRaw(next[latest]?.raw || "");
    } else {
      setSelectedDate(getTodayISO());
      setReportTitle("Night Report");
      setRaw("");
    }
  }

  function handleExport() {
    const blob = new Blob([JSON.stringify(reports, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href = url;
    a.download = `night-reports-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(String(reader.result));
        if (typeof imported !== "object" || Array.isArray(imported)) {
          alert("Invalid file format.");
          return;
        }
        const merged = { ...reports, ...imported };
        setReports(merged);
        saveAllReports(merged);
        const dates = Object.keys(merged).sort();
        if (dates.length) {
          const latest = dates[dates.length - 1];
          setSelectedDate(latest);
          setReportTitle(merged[latest]?.title || "Night Report");
          setRaw(merged[latest]?.raw || "");
        }
        e.target.value = "";
      } catch {
        alert("Failed to read JSON file.");
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto">
      {/* Top controls */}
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-6">
        <div className="space-y-2">
          <h1 className="text-2xl md:text-3xl font-semibold">Night Report Dashboard</h1>
          <p className="text-sm text-gray-600">
            8 placeholders: 252, 253, 260, 261, 262, 263, 265, 266. Mapping: F → 25x, S → 26x (e.g., F2→252, F3→253, S1→261).
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 md:gap-3">
          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Report date</span>
            <input
              type="date"
              className="border rounded px-3 py-2 text-sm w-full"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            />
          </label>

          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Title</span>
            <input
              type="text"
              className="border rounded px-3 py-2 text-sm w-full"
              value={reportTitle}
              onChange={(e) => setReportTitle(e.target.value)}
              placeholder="Night Report"
            />
          </label>

          <div className="flex gap-2 col-span-1 md:col-span-2">
            <button className="border rounded px-3 py-2 text-sm bg-blue-600 text-white" onClick={handleSave}>
              Save report to this date
            </button>
            <button className="border rounded px-3 py-2 text-sm" onClick={() => handleLoadDate(selectedDate)}>
              Load saved for this date
            </button>
            <button className="border rounded px-3 py-2 text-sm text-red-700" onClick={() => handleDeleteDate(selectedDate)}>
              Delete this date
            </button>
          </div>
        </div>
      </header>

      {/* Body: left=textarea, right=saved dates + import/export */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2">
          <h2 className="text-lg font-semibold mb-2">Paste Night Report</h2>
          <textarea
            className="w-full min-h-[360px] border rounded p-3"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="Paste your Night Report here…"
          />
          <div className="mt-2 text-sm text-gray-600">
            Tips: keep headers like <code>*S2 - GR</code>, <code>S0 - Major Serv …</code>, <code>*F2 - S</code>.
            Lines starting with <code>-</code> or <code>&gt;</code> become bullet notes.
          </div>
        </div>

        <aside className="lg:col-span-1">
          <h2 className="text-lg font-semibold mb-2">Saved reports (by date)</h2>
          {savedDates.length === 0 ? (
            <div className="text-sm text-gray-500">No saved reports yet.</div>
          ) : (
            <ul className="border rounded divide-y">
              {savedDates.map((d) => (
                <li key={d} className={`p-2 text-sm ${d === selectedDate ? "bg-gray-50" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <button className="underline text-blue-700" onClick={() => handleLoadDate(d)}>
                      {d} — {reports[d]?.title || "Night Report"}
                    </button>
                    <button className="text-red-700" onClick={() => handleDeleteDate(d)}>
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex flex-col gap-2">
            <button className="border rounded px-3 py-2 text-sm" onClick={handleExport}>
              Export all to JSON
            </button>
            <label className="text-sm border rounded px-3 py-2 cursor-pointer text-center">
              Import from JSON
              <input type="file" accept="application/json" className="hidden" onChange={handleImport} />
            </label>
          </div>
        </aside>
      </section>

      {/* Cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(({ id, code, entry }) => {
          const tag = entry?.tag || "none";
          const classes = entry ? statusToClasses(tag) : "bg-gray-50 border-gray-200";
          return (
            <div key={id} className={`border rounded-2xl p-4 shadow-sm ${classes}`}>
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
                    {entry.input && <span className="px-2 py-0.5 bg-white border rounded">Input: {entry.input}</span>}
                    {entry.etr && <span className="px-2 py-0.5 bg-white border rounded">ETR: {entry.etr}</span>}
                    <span className="px-2 py-0.5 bg-white border rounded">
                      {tag === "serviceable" && "Serviceable"}
                      {tag === "rectification" && "Rectification"}
                      {tag === "in-phase" && "In Phase"}
                      {tag === "recovery" && "Recovery"}
                      {tag === "none" && "No status"}
                    </span>
                  </div>
                  {entry.notes?.length > 0 && (
                    <ul className="list-disc pl-5 text-sm space-y-1">
                      {entry.notes.map((n, i) => (
                        <li key={i} className="whitespace-pre-wrap">
                          {n}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <div className="italic text-sm text-gray-500">No data parsed for {code}.</div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

/* =========================
   Utilities & sample text
   ========================= */
function getTodayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const DEFAULT_SAMPLE = `Night Report for 8 Aug (Fri)

5 x ‘S’ Bird
F2, F3, S3, S5, S6 

Fishing 🎣
Nil

Healing ❤️‍🩹 
Nil

Status 🚁 
(* denotes fitted with 'S' EOSS TU) 
(^ denotes fitted with ‘U/S’  EOSS TU) 

S0  - Major Serv (Phase A + 365D)
Input: 200525
ETR: 260825 

*S1 - Major Serv (365D + W)
Input: 280725
ETR: 101125 

*S2 - GR
ETR: 080825/2200

> Post phase rcv 

- Defect: TGB Input seal found with leak
> TGB Oil drained
> #6 Driveshaft removed 
> Tail Rotor Boot Assy installed 
> TGB indication and Chip detector checkout completed
> 2 times Paint touch up TBCO at IGB, TGB and No.6 D/S fairing completed

Requirements
- G/R
> 100% NR for 15 mins
> Checkout Procedure of TGB and Indicating System
- Post G/R
> Flex Coupling Inspection

- FCF
> 1/Rev (Passed), 4/Rev
> Autorotation Check
> Profile B post Eng 450H
> Profile C post Disconnect Shaft replacement 
> Profle D post AFCC replacement
*S3 - S

- Defect: RH Main Wheel Observed With Abnormal Noise Heard during towing
> Wheel Brake Unit replaced and bleeding carried out

*S5 - S

- KGX40, SG50and SG50 mount removed (requested by TACCO)
> Limitation opened for "no link 11 operation due kgx40 and sg50 removed for ops requirement". 
> Limit to next 365D due @ 191125

*S6 - S

- TFOA (FAIR): Troop seat mic tel lead push-to-talk button cover found missing during running change 
> Hoist Mic tel lead replaced
> ICS system checkout procedure done 
> Loose Article Check TBCO for Hoist Mic Tel Lead Push Button Retaining Ring 
in cabin area (Transferred to ADDL till next 365D (dtd: 260825)

- Defect: ESM display "No Go - T"
> RPU replaced
> esm procedure checkout carried out 

- Defect: Qty: 01 Belly Fuselage drain hole found with 0.8 inch crack. Cracked portion and rubber disk removed. (Located at buttline: RH20, Station: 370, waterline: 206.7)
> Transferred to ADDL till next 365D Serv (Dated: 260825)

*F2 - S

*F3 - S`;
