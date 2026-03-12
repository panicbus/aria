import { signalColors } from "../../config";

export function MetricCard({
  label,
  value,
  sub,
  signal,
  rsi,
}: {
  label: string;
  value: string;
  sub?: string;
  signal?: string;
  rsi?: number;
}) {
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
          fontSize: 10,
          letterSpacing: "0.12em",
          color: "#888",
          textTransform: "uppercase",
          marginBottom: 5,
          fontFamily: "var(--mono)",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: "#f0f0f0", fontFamily: "var(--display)", lineHeight: 1 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "#555", marginTop: 3, fontFamily: "var(--mono)" }}>{sub}</div>
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
