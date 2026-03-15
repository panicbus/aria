import React from "react";

const PHASES = [
  { label: "1 — The Shell", done: true },
  { label: "2 — The Eyes", done: true },
  { label: "3 — The Brain", done: true },
  { label: "4 — The Edge", done: true },
  { label: "5 — The Scanner", done: true },
  { label: "6a — Real Portfolio: Crypto", done: true },
];

export function BuildPhaseList() {
  return (
    <div>
      <div style={{ fontSize: 9, letterSpacing: "0.14em", color: "#444", textTransform: "uppercase", fontFamily: "var(--mono)", marginBottom: 8 }}>Build Phase</div>
      {PHASES.map((p) => (
        <div key={p.label} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", marginBottom: 5, background: p.done ? "rgba(0,255,148,0.06)" : "rgba(255,255,255,0.02)", border: p.done ? "1px solid rgba(0,255,148,0.15)" : "1px solid rgba(255,255,255,0.05)", borderRadius: 8 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: p.done ? "#00ff94" : "#2a2a2a" }} />
          <span style={{ fontSize: 11, color: p.done ? "#00ff94" : "#444", fontFamily: "var(--mono)" }}>{p.label}</span>
        </div>
      ))}
    </div>
  );
}
