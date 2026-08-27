/**
 * piwork-ask — a tool the model can call to ask the user a question mid-turn.
 *
 * Pi ships no built-in "ask the user" tool, so this fills that gap. It renders through
 * `ctx.ui` (select for a choice, confirm for yes/no, input for free text), which the
 * Piwork shell shows as a native modal, and returns the answer to the model.
 * (v1: single question. Multi-field forms are a future first-class `form` intent.)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask the user",
    description:
      "Ask the user a question and wait for their answer. Provide `options` for multiple choice, set `yesNo` for a confirmation, or omit both for free text.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to show the user." },
        options: { type: "array", items: { type: "string" }, description: "Choices for a multiple-choice question." },
        yesNo: { type: "boolean", description: "If true, ask a yes/no confirmation." },
      },
      required: ["question"],
    } as never,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const p = params as { question: string; options?: string[]; yesNo?: boolean };
      const ui = (ctx as { ui: {
        select: (t: string, o: string[]) => Promise<string | undefined>;
        confirm: (t: string, m: string) => Promise<boolean>;
        input: (t: string, ph?: string) => Promise<string | undefined>;
      } }).ui;

      let answer: string;
      if (p.yesNo) {
        answer = (await ui.confirm(p.question, "")) ? "yes" : "no";
      } else if (Array.isArray(p.options) && p.options.length > 0) {
        const choice = await ui.select(p.question, p.options);
        answer = choice ?? "(cancelled)";
      } else {
        const text = await ui.input(p.question);
        answer = text ?? "(cancelled)";
      }
      return { content: [{ type: "text", text: `User answered: ${answer}` }], details: { answer } };
    },
  });
}
