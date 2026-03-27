import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const markdownChatStyles = {
  p: { margin: "0 0 0.6em 0" },
  "p:last-child": { marginBottom: 0 },
  strong: { fontWeight: 700, color: "#f0f0f0" },
  em: { fontStyle: "italic" },
  code: { fontFamily: "var(--mono)", fontSize: "0.9em", background: "rgba(0,255,148,0.08)", color: "#00ff94", padding: "2px 6px", borderRadius: 4 },
  pre: { margin: "0.5em 0", padding: 12, background: "rgba(0,0,0,0.3)", borderRadius: 8, overflow: "auto", border: "1px solid rgba(255,255,255,0.06)" },
  "pre code": { background: "none", padding: 0, color: "#ccc" },
  ul: { margin: "0.4em 0 0.4em 1.2em", paddingLeft: "1.2em" },
  ol: { margin: "0.4em 0 0.4em 1.2em", paddingLeft: "1.2em" },
  li: { marginBottom: 0.25 },
  blockquote: { margin: "0.5em 0", paddingLeft: 14, borderLeft: "3px solid rgba(0,255,148,0.4)", color: "#aaa" },
  a: { color: "#00ff94", textDecoration: "none" },
  "a:hover": { textDecoration: "underline" },
  h1: { fontSize: "1.2em", fontWeight: 700, margin: "0.75em 0 0.35em", color: "#f0f0f0" },
  h2: { fontSize: "1.1em", fontWeight: 700, margin: "0.6em 0 0.3em", color: "#e8e8e8" },
  h3: { fontSize: "1em", fontWeight: 700, margin: "0.5em 0 0.25em", color: "#ddd" },
  table: { width: "100%", borderCollapse: "collapse" as const, margin: "0.5em 0", fontSize: "0.95em" },
  th: { textAlign: "left" as const, padding: "6px 10px", borderBottom: "1px solid rgba(255,255,255,0.15)", color: "#00ff94" },
  td: { padding: "6px 10px", borderBottom: "1px solid rgba(255,255,255,0.06)" },
  hr: { border: "none", borderTop: "1px solid rgba(255,255,255,0.1)", margin: "0.75em 0" },
};

export function MarkdownContent({ content, className = "" }: { content: string; className?: string }) {
  const trimmed = (content ?? "").replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    return (
      <span style={{ color: "#666", fontFamily: "var(--mono)", fontSize: 12, fontStyle: "italic" }}>
        (no text in this message)
      </span>
    );
  }

  return (
    <div className={className} style={{ wordBreak: "break-word", color: "#ccc" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }: { children?: React.ReactNode }) => <p style={markdownChatStyles.p}>{children}</p>,
          strong: ({ children }: { children?: React.ReactNode }) => <strong style={markdownChatStyles.strong}>{children}</strong>,
          em: ({ children }: { children?: React.ReactNode }) => <em style={markdownChatStyles.em}>{children}</em>,
          code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
            const isBlock = className?.startsWith("language-");
            if (isBlock) {
              return <pre style={markdownChatStyles.pre}><code style={markdownChatStyles["pre code"]}>{children}</code></pre>;
            }
            return <code style={markdownChatStyles.code}>{children}</code>;
          },
          ul: ({ children }: { children?: React.ReactNode }) => <ul style={markdownChatStyles.ul}>{children}</ul>,
          ol: ({ children }: { children?: React.ReactNode }) => <ol style={markdownChatStyles.ol}>{children}</ol>,
          li: ({ children }: { children?: React.ReactNode }) => <li style={markdownChatStyles.li}>{children}</li>,
          blockquote: ({ children }: { children?: React.ReactNode }) => <blockquote style={markdownChatStyles.blockquote}>{children}</blockquote>,
          a: ({ href, children }: { href?: string; children?: React.ReactNode }) => <a href={href} target="_blank" rel="noopener noreferrer" style={markdownChatStyles.a}>{children}</a>,
          h1: ({ children }: { children?: React.ReactNode }) => <h1 style={markdownChatStyles.h1}>{children}</h1>,
          h2: ({ children }: { children?: React.ReactNode }) => <h2 style={markdownChatStyles.h2}>{children}</h2>,
          h3: ({ children }: { children?: React.ReactNode }) => <h3 style={markdownChatStyles.h3}>{children}</h3>,
          table: ({ children }: { children?: React.ReactNode }) => <table style={markdownChatStyles.table}>{children}</table>,
          th: ({ children }: { children?: React.ReactNode }) => <th style={markdownChatStyles.th}>{children}</th>,
          td: ({ children }: { children?: React.ReactNode }) => <td style={markdownChatStyles.td}>{children}</td>,
          hr: () => <hr style={markdownChatStyles.hr} />,
        }}
      >
        {trimmed}
      </ReactMarkdown>
    </div>
  );
}
