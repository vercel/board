import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";
import { ACTIONS, HEIGHT, script, SHOT, WIDTH } from "../lib/computer";

export default defineTool({
  description: `Use a virtual ${WIDTH}x${HEIGHT} desktop like a person: see it, click, type. Each call does one action and returns a screenshot of the screen afterwards, so look at it before the next action. Coordinates are pixels from the top-left of that screenshot.
Actions: screenshot; open (url: opens it in Chrome, or command: starts a program on the desktop); click, double_click, right_click, move (x, y); drag (x, y to to_x, to_y); type (text, into whatever has focus: click the field first); key (keys, like "Return", "ctrl+l", "shift+Tab", several separated by spaces); scroll (x, y, amount: wheel clicks, positive down); wait (seconds).
While ui-video is recording, each call's title is the video's caption from then on.`,
  inputSchema: z.object({
    title: z
      .string()
      .describe('What you\'re doing, as one short first-person sentence ("Opening the login page"). It\'s the video caption while recording.'),
    action: z.enum(ACTIONS),
    x: z.number().optional(),
    y: z.number().optional(),
    to_x: z.number().optional(),
    to_y: z.number().optional(),
    text: z.string().optional(),
    keys: z.string().optional(),
    url: z.string().optional(),
    command: z.string().optional().describe("For open: a shell command to start on the desktop."),
    amount: z.number().optional(),
    seconds: z.number().optional(),
  }),
  async execute(input, ctx) {
    const sandbox = await ctx.getSandbox();
    const done = await sandbox.run({ command: script(input) });
    if (done.exitCode !== 0) throw new Error(done.stderr.trim().slice(-500) || `${input.action} failed`);
    const png = await sandbox.readBinaryFile({ path: SHOT });
    if (!png) throw new Error("no screenshot");
    return { action: input.action, screenshot: Buffer.from(png).toString("base64") };
  },
  toModelOutput(output) {
    return toolOutput.content([
      toolOutputPart.text(`${output.action} done. The screen now:`),
      toolOutputPart.file(output.screenshot, { mediaType: "image/png" }),
    ]);
  },
});
