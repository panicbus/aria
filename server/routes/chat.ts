/**
 * Chat and history API routes.
 * POST /chat — send message, get reply (with tool-calling loop);
 * GET /history — list messages; DELETE /history — clear messages.
 */

import { Router, Request, Response } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_TOOLS } from "../services/chatTools";

type ChatDeps = {
  db: import("sql.js").Database;
  execAll: <T extends Record<string, unknown>>(sql: string) => T[];
  saveDb: () => void;
  buildLiveContext: () => string;
  buildMemoryContext: () => string;
  systemPrompt: string;
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
    handleToolCall,
    runMemoryExtraction,
  } = deps;

  router.post("/chat", async (req: Request, res: Response) => {
    const { message, quick } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });
    const useQuickMode = quick === true;

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
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction: fullSystemPrompt,
        generationConfig: { maxOutputTokens: useQuickMode ? 512 : 4096 },
        ...(useQuickMode ? {} : { tools: GEMINI_TOOLS }),
      });

      let geminiHistory = history.slice(0, -1).map((m) => ({
        role: m.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: [{ text: m.content }],
      }));
      // Gemini requires first content to be from user — strip any leading model messages
      while (geminiHistory.length > 0 && geminiHistory[0].role === "model") {
        geminiHistory = geminiHistory.slice(1);
      }
      const lastMessage = history[history.length - 1]?.content ?? message;

      const chat = model.startChat({ history: geminiHistory });
      let result = await chat.sendMessage(lastMessage);

      while (true) {
        const response = result.response;
        const functionCalls = response.functionCalls?.();
        if (!functionCalls || functionCalls.length === 0) break;

        const toolResults = [];
        for (const call of functionCalls) {
          const toolResult = await handleToolCall(call.name, call.args ?? {});
          // Gemini requires response to be an object, not an array — wrap arrays/primitives
          const responseObj = typeof toolResult === "object" && toolResult !== null && !Array.isArray(toolResult)
            ? toolResult
            : { result: toolResult };
          toolResults.push({
            functionResponse: {
              name: call.name,
              response: responseObj,
            },
          });
        }
        result = await chat.sendMessage(toolResults);
      }

      const reply = (result.response as { text?: () => string }).text?.() ?? "";

      db.run("INSERT INTO messages (role, content) VALUES (:role, :content)", {
        ":role": "assistant",
        ":content": reply,
      });
      saveDb();

      runMemoryExtraction(message, reply).catch((e) => console.warn("Memory extraction:", e));

      res.json({ reply });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Gemini API error:", msg);
      res.status(500).json({ error: "Gemini API error", detail: msg });
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
