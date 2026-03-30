import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";

import { signalColors } from "../../config";

function InfoTooltip({ anchor, content }: { anchor: HTMLElement; content: string }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const rect = anchor.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left });
  }, [anchor]);

  if (!pos) return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        background: "#1a1a1a",
        border: "0.5px solid rgba(255,255,255,0.15)",
        borderRadius: 6,
        padding: "7px 9px",
        fontSize: 10,
        color: "#aaa",
        lineHeight: 1.5,
        fontFamily: "var(--mono)",
        width: 200,
        zIndex: 9999,
        pointerEvents: "none",
        boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
      }}
    >
      {content}
    </div>,
    document.body
  );
}

export function MetricCard({
  label,
  value,
  sub,
  signal,
  rsi,
  infoTip,
}: {
  label: string;
  value: string;
  sub?: string;
  signal?: string;
  rsi?: number;
  infoTip?: string;
}) {
  const [showTip, setShowTip] = useState(false);
  const infoRef = useRef<HTMLSpanElement>(null);
  const rsiColor = rsi != null ? (rsi > 70 ? "#ff4757" : rsi < 30 ? "#00ff94" : "#f0f0f0") : undefined;
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 12,
        padding: "14px 16px",
        position: "relative",
        cursor: "default",
        transition: "border-color 0.2s",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 5,
        }}
      >
        <span
          style={{
            fontFamily: "Syne, var(--display)",
            fontWeight: 700,
            fontSize: 13,
            color: "#c2c2c2",
            lineHeight: 1,
          }}
        >
          {label}
        </span>
        {infoTip && (
          <span
            ref={infoRef}
            className="market-health-info"
            onMouseEnter={() => setShowTip(true)}
            onMouseLeave={() => setShowTip(false)}
            style={{
              fontSize: 12,
              color: "#444",
              cursor: "default",
              lineHeight: 1,
            }}
          >
            ⓘ
          </span>
        )}
        {showTip && infoTip && infoRef.current && (
          <InfoTooltip anchor={infoRef.current} content={infoTip} />
        )}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: "#f0f0f0", fontFamily: "var(--display)", lineHeight: 1 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "#777", marginTop: 3, fontFamily: "var(--mono)" }}>{sub}</div>
      )}
      {rsi != null && (
        <div style={{ fontSize: 10, color: rsiColor, fontFamily: "var(--mono)", marginTop: 2 }}>
          RSI {rsi.toFixed(0)}
        </div>
      )}
      {signal && (
        <div
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            background: `${(signalColors[signal] ?? "#888")}18`,
            border: `1px solid ${(signalColors[signal] ?? "#888")}40`,
            color: signalColors[signal] ?? "#888",
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.1em",
            padding: "2px 7px",
            borderRadius: 20,
            fontFamily: "var(--mono)",
          }}
        >
          {signal}
        </div>
      )}
    </div>
  );
}
