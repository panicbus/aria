/**
 * WAYPOINT: Gemini Client
 * WHAT: Initializes the Google Gemini client (model configurable via GEMINI_MODEL)
 * WHY: Single source of truth for AI client — swap models via .env without code changes
 * HOW IT HELPS NICO: Free AI tier keeps ARIA running at zero ongoing cost
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

export const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";

if (!process.env.GEMINI_API_KEY?.trim()) {
  console.warn("WARNING: GEMINI_API_KEY not set. AI features will not work.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export const geminiModel = genAI.getGenerativeModel({
  model: GEMINI_MODEL,
  generationConfig: { maxOutputTokens: 4096 },
});

/**
 * Simple text generation (no tools).
 */
export async function generateText(prompt: string, systemInstruction?: string): Promise<string> {
  try {
    const model = systemInstruction
      ? genAI.getGenerativeModel({
          model: GEMINI_MODEL,
          systemInstruction,
          generationConfig: { maxOutputTokens: 4096 },
        })
      : geminiModel;
    const result = await model.generateContent(prompt);
    const response = result.response;
    return response.text();
  } catch (err) {
    console.error("Gemini generateText error:", err);
    return "ARIA is temporarily unavailable.";
  }
}

/**
 * Chat with history (for multi-turn conversation).
 */
export async function generateChatResponse(
  messages: { role: "user" | "model"; parts: string }[],
  systemInstruction: string
): Promise<string> {
  try {
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction,
      generationConfig: { maxOutputTokens: 4096 },
    });
    const history = messages.slice(0, -1).map((m) => ({
      role: m.role as "user" | "model",
      parts: [{ text: m.parts }],
    }));
    const chat = model.startChat({ history });
    const lastMessage = messages[messages.length - 1];
    const result = await chat.sendMessage(lastMessage.parts);
    return result.response.text();
  } catch (err) {
    console.error("Gemini chat error:", err);
    return "ARIA is temporarily unavailable.";
  }
}
