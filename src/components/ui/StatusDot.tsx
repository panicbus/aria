export function StatusDot({ active }: { active: boolean }) {
  return (
    <div
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: active ? "#00ff94" : "#ff4757",
        boxShadow: active ? "0 0 8px #00ff94" : "none",
        transition: "all 0.3s",
      }}
    />
  );
}
