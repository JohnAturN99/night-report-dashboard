import React, { useEffect, useMemo, useRef, useState } from "react";
import { db, auth, onAuthStateChanged, signInWithGoogle, signOut } from "./firebase";
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

/* =========================
   Helpers
   ========================= */
function idToCode(id) {
  if (id >= 251 && id <= 259) return `F${id - 250}`; // 252->F2, 253->F3
  if (id >= 260 && id <= 269) return `S${id - 260}`; // 260->S0, 261->S1, ...
  return String(id);
}

// In-phase is based on HEADER only (ignore "365D" appearing in notes)
function deriveStatusTag(entry) {
  const title = entry.title.toLowerCase();
  const notes = entry.notes.join(" ").toLowerCase();

  const hasDefect =
    /\bdefect:/.test(title) ||
    /\bdefect:/.test(notes) ||
    /\bgr\b/.test(title) ||
    /\bgr\b/.test(notes);

  const inPhase = /(major serv|phase\b)/.test(title); // header-only
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

// Parse the pasted report into a map of entries by code (S1, F2, etc.)
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

  // attach status tag
  Object.keys(entries).forEach((k) => {
    entries[k].tag = deriveStatusTag(entries[k]);
  });

  return entries;
}

function getTodayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/* =========================
   App
   ========================= */
export default function App() {
  // Auth state
  const [user, setUser] = useState(null);
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  // UI state
  const [selectedDate, setSelectedDate] = useState(getTodayISO()); // yyyy-mm-dd
  const [reportTitle, setReportTitle] = useState("Night Report");
  const [raw, setRaw] = useState(""); // pasted text

  // Cloud state
  const [cloudDates, setCloudDates] = useState([]); // list of available dates in Firestore
  const docUnsubRef = useRef(null); // keep one live listener per selected date

  // Listen to the list of report docs (ordered by doc id = date)
  useEffect(() => {
    const qy = query(collection(db, "reports"), orderBy("__name__"));
    const unsub = onSnapshot(qy, (snap) => {
      const dates = [];
      snap.forEach((d) => dates.push(d.id));
      dates.sort().reverse(); // newest first
      setCloudDates(dates);

      // Auto-load a date: prefer current if exists, else newest
      const hasSelected = dates.includes(selectedDate);
      if (dates.length && !hasSelected) {
        loadCloudDate(dates[0]);
      } else if (hasSelected) {
        loadCloudDate(selectedDate);
      }
      // If no dates exist yet, keep whatever is in raw; user can save
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clean up the per-doc listener on unmount
  useEffect(() => {
    return () => {
      if (docUnsubRef.current) docUnsubRef.current();
    };
  }, []);

  // Start/replace the per-date live listener
  function loadCloudDate(date) {
    if (!date) return;
    setSelectedDate(date);
    if (docUnsubRef.current) docUnsubRef.current();
    const dref = doc(db, "reports", date);
    docUnsubRef.current = onSnapshot(dref, (snap) => {
      const data = snap.data();
      if (data) {
        setReportTitle(data.title || "Night Report");
        setRaw(data.raw || "");
      } else {
        // Doc doesn't exist -> clear editor (or keep previous text)
        setReportTitle("Night Report");
        setRaw("");
      }
    });
  }

  // Save to Firestore (only allowed for whitelisted Google emails per rules)
  async function handleSave() {
    if (!user) {
      alert("Please sign in with Google to save.");
      return;
    }
    try {
      await setDoc(doc(db, "reports", selectedDate), {
        title: reportTitle || "Night Report",
        raw,
        updatedAt: serverTimestamp(),
      });
      alert(`Saved cloud report for ${selectedDate}.`);
    } catch (e) {
      alert("Save failed (check Firestore rules/whitelist).");
      console.error(e);
    }
  }

  // Delete a report date from Firestore
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
      alert("Delete failed (check Firestore rules/whitelist).");
      console.error(e);
    }
  }

  // Parse the current raw text
  const parsed = useMemo(() => parseReport(raw), [raw]);

  // Cards in the fixed placeholder order
  const cards = useMemo(() => {
    return PLACEHOLDERS.map((id) => {
      const code = idToCode(id);
      const entry = parsed[code];
      return { id, code, entry };
    });
  }, [parsed]);

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
            <button className="border rounded px-3 py-2 text-sm" onClick={signInWithGoogle}>
              Sign in with Google to edit
            </button>
          )}
        </div>
      </div>

      {/* Controls */}
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 md:gap-3">
          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Report date</span>
            <input
              type="date"
              className="border rounded px-3 py-2 text-sm w-full"
              value={selectedDate}
              onChange={(e) => loadCloudDate(e.target.value)}
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
            <button
              className={`border rounded px-3 py-2 text-sm text-white ${
                user ? "bg-blue-600" : "bg-gray-400 cursor-not-allowed"
              }`}
              onClick={handleSave}
              disabled={!user}
            >
              Save report to this date (cloud)
            </button>
          </div>
        </div>
      </header>

      {/* Body: left=textarea, right=saved dates */}
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
            Tips: keep headers like <code>*S2 - GR</code>, <code>S0 - Major Serv …</code>,{" "}
            <code>*F2 - S</code>. Lines starting with <code>-</code> or <code>&gt;</code> become
            bullet notes.
          </div>
        </div>

        <aside className="lg:col-span-1">
          <h2 className="text-lg font-semibold mb-2">Saved reports (cloud)</h2>
          {cloudDates.length === 0 ? (
            <div className="text-sm text-gray-500">No cloud reports yet.</div>
          ) : (
            <ul className="border rounded divide-y">
              {cloudDates.map((d) => (
                <li key={d} className={`p-2 text-sm ${d === selectedDate ? "bg-gray-50" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <button
                      className="underline text-blue-700"
                      onClick={() => loadCloudDate(d)}
                      title="Load this date"
                    >
                      {d}
                    </button>
                    <button
                      className={`${
                        user ? "text-red-700" : "text-gray-400 cursor-not-allowed"
                      }`}
                      onClick={() => handleDeleteDate(d)}
                      disabled={!user}
                      title="Delete this date"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
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
                    {entry.input && (
                      <span className="px-2 py-0.5 bg-white border rounded">
                        Input: {entry.input}
                      </span>
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
