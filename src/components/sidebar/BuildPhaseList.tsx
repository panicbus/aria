import React from "react";

const PHASES = [
  { label: "1 — The Shell", done: true, date: "Mar 11" },
  { label: "2 — The Eyes", done: true, date: "Mar 12" },
  { label: "3 — The Brain", done: true, date: "Mar 15" },
  { label: "4 — The Edge", done: true, date: "Mar 16" },
  { label: "5 — The Scanner", done: true, date: "Mar 16" },
  { label: "6 — Real Portfolio", done: true, date: "Mar 15" },
  { label: "7 — Dynamic Universe", done: true, date: "Mar 27" },
];

export function BuildPhaseList() {
  return (
    <div style={{ flexShrink: 0 }}>
      <div style={{ fontSize: 9, letterSpacing: "0.14em", color: "#444", textTransform: "uppercase", fontFamily: "var(--mono)", marginBottom: 8 }}>Build Phase</div>
      {PHASES.map((p) => (
        <div key={p.label} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", marginBottom: 4, background: p.done ? "rgba(0,255,148,0.06)" : "rgba(255,255,255,0.02)", border: p.done ? "1px solid rgba(0,255,148,0.15)" : "1px solid rgba(255,255,255,0.05)", borderRadius: 8 }}>
          <div style={{ width: 5, height: 5, borderRadius: "50%", background: p.done ? "#00ff94" : "#2a2a2a", flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: p.done ? "#00ff94" : "#444", fontFamily: "var(--mono)", flex: 1 }}>{p.label}</span>
          <span style={{ fontSize: 9, color: "#444", fontFamily: "var(--mono)", flexShrink: 0 }}>{p.date}</span>
        </div>
      ))}
    </div>
  );
}
