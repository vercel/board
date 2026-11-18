import { gateway, generateSpeech } from "ai";
import { defineTool } from "eve/tools";
import { z } from "zod";

// A ui-demo recording's narrator: the voice is made here, through AI Gateway with the deployment's own
// credentials, so the sandbox never holds a gateway key. The skill's script captions the line, plays
// the voice from that moment, and waits until it's been said, so the action that follows comes after it.

const VOICE_MODEL = "openai/tts-1";
const VOICE = "nova";
const CLIP = "/tmp/ui-demo-line.mp3";

/** Single quotes for sh, with any quote in the text closed and reopened. */
const quoted = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

export default defineTool({
  description:
    "During a ui-demo recording, says one line out loud and captions it, just before the action it describes. Lines are short, first-person, and written to be heard: 'Opening the settings page'. Follow the ui-demo skill.",
  inputSchema: z.object({ line: z.string().trim().min(1).max(200) }),
  async execute({ line }, ctx) {
    const sandbox = await ctx.getSandbox();
    if (!sandbox) throw new Error("narrate needs the sandbox the recording runs in");
    let voice = "";
    try {
      const { audio } = await generateSpeech({ model: gateway.speechModel(VOICE_MODEL), text: line, voice: VOICE, outputFormat: "mp3", abortSignal: ctx.abortSignal });
      await sandbox.writeBinaryFile({ path: CLIP, content: audio.uint8Array });
      voice = ` --voice ${CLIP}`;
    } catch (error) {
      console.warn("[factory] couldn't make the narration's voice, so this line is captioned only:", error);
    }
    const step = await sandbox.run({ command: `"$HOME/.agents/skills/ui-demo/scripts/ui-demo" step ${quoted(line)}${voice}` });
    if (step.exitCode !== 0) return `not narrated: ${(step.stderr || step.stdout).trim()}`;
    return voice ? "said and captioned" : "captioned only: the voice couldn't be made";
  },
});
