/**
 * Chat and history API routes.
 * POST /chat — send message, get reply (with tool-calling loop);
 * GET /history — list messages; DELETE /history — clear messages.
 */

import { Router, Request, Response } from "express";
import type Anthropic from "@anthropic-ai/sdk";

type ChatDeps = {
  db: import("sql.js").Database;
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
  saveDb: () => void;
  buildLiveContext: () => string;
  buildMemoryContext: () => string;
  systemPrompt: string;
  anthropic: Anthropic;
  tools: any[];
  handleToolCall: (name: string, input: any) => Promise<any>;
  runMemoryExtraction: (userContent: string, assistantContent: string) => Promise<void>;
};

export function createChatRouter(deps: ChatDeps): Router {
  const router = Router();
  const {
    db,
    execAll,
    saveDb,
    buildLiveContext,
    buildMemoryContext,
    systemPrompt,
    anthropic,
    tools,
    handleToolCall,
    runMemoryExtraction,
  } = deps;

  router.post("/chat", async (req: Request, res: Response) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });

    db.run("INSERT INTO messages (role, content) VALUES (:role, :content)", {
      ":role": "user",
      ":content": message,
    });
    saveDb();

    const rows = execAll<{ role: string; content: string }>(
      "SELECT role, content FROM messages ORDER BY created_at DESC LIMIT 20"
    );
    const history = rows.reverse();

    const liveContext = buildLiveContext();
    const memoryContext = buildMemoryContext();
    const fullSystemPrompt = systemPrompt + memoryContext + liveContext;

    try {
      const baseMessages = history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      let currentMessages: any[] = [...baseMessages];
      let finalResponse: any = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 4096,
        system: fullSystemPrompt,
        tools,
        tool_choice: { type: "auto" },
        messages: currentMessages,
      } as any);

      while (true) {
        const toolUses = (finalResponse.content as any[]).filter((c: any) => c.type === "tool_use");
        if (toolUses.length === 0) break;

        const toolResultBlocks: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
        for (const tu of toolUses as Array<{ id: string; name: string; input: any }>) {
          const result = await handleToolCall(tu.name, tu.input);
          toolResultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) });
        }
        currentMessages = [
          ...currentMessages,
          { role: "assistant", content: finalResponse.content },
          { role: "user", content: toolResultBlocks },
        ];
        finalResponse = await anthropic.messages.create({
          model: "claude-sonnet-4-5",
          max_tokens: 4096,
          system: fullSystemPrompt,
          tools,
          tool_choice: { type: "auto" },
          messages: currentMessages,
        } as any);
      }

      const textBlock = (finalResponse.content as any[]).find((c: any) => c.type === "text") as { text: string } | undefined;
      const reply = textBlock?.text ?? "";

      db.run("INSERT INTO messages (role, content) VALUES (:role, :content)", {
        ":role": "assistant",
        ":content": reply,
      });
      saveDb();

      runMemoryExtraction(message, reply).catch((e) => console.warn("Memory extraction:", e));

      res.json({ reply });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Claude API error:", msg);
      res.status(500).json({ error: "Claude API error", detail: msg });
    }
  });

  router.get("/history", (req: Request, res: Response) => {
    const messages = execAll("SELECT * FROM messages ORDER BY created_at ASC LIMIT 100");
    res.json(messages);
  });

  router.delete("/history", (req: Request, res: Response) => {
    db.run("DELETE FROM messages");
    saveDb();
    res.json({ cleared: true });
  });

  return router;
}
