export function TypingIndicator() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "5px", padding: "12px 16px" }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "#00ff94",
            animation: "pulse 1.2s ease-in-out infinite",
            animationDelay: `${i * 0.2}s`,
            opacity: 0.7,
          }}
        />
      ))}
    </div>
  );
}
