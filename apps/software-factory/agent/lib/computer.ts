import { SANDBOX_USER } from "../../app/api/board/[[...path]]/harness.ts";

export const XINPUT = `/home/${SANDBOX_USER}/.computer/xinput.py`;

const DISPLAY = ":99";
export const [WIDTH, HEIGHT] = [1280, 800];
const HOME = `/home/${SANDBOX_USER}`;
export const SHOT = "/tmp/computer.png";
export const ACTIONS = ["screenshot", "open", "click", "double_click", "right_click", "move", "drag", "type", "key", "scroll", "wait"] as const;

const q = (value: string | number) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export type ComputerInput = {
  title: string;
  action: (typeof ACTIONS)[number];
  x?: number | undefined;
  y?: number | undefined;
  to_x?: number | undefined;
  to_y?: number | undefined;
  text?: string | undefined;
  keys?: string | undefined;
  url?: string | undefined;
  command?: string | undefined;
  amount?: number | undefined;
  seconds?: number | undefined;
};

function need<T>(value: T | undefined, what: string, action: string): T {
  if (value === undefined || value === "") throw new Error(`${action} needs ${what}`);
  return value;
}

export function script(p: ComputerInput) {
  const xy = () => [Math.round(need(p.x, "x", p.action)), Math.round(need(p.y, "y", p.action))];
  const input = (...args: (string | number)[]) => `python3 ${XINPUT} ${args.map(q).join(" ")}`;
  let act = "";
  switch (p.action) {
    case "screenshot":
      break;
    case "open":
      act = p.url
        ?           `chrome=$(ls -d ${HOME}/.agent-browser/browsers/chrome-*/ 2>/dev/null | sort | tail -1)
[ -n "$chrome" ] || { echo "no Chrome: run agent-browser install" >&2; exit 1; }
setsid "$chrome/chrome" --no-first-run --no-default-browser-check --disable-search-engine-choice-screen --disable-infobars \\
  --user-data-dir=${HOME}/.computer-chrome --window-position=0,0 --window-size=${WIDTH},${HEIGHT} ${q(p.url)} >/dev/null 2>&1 < /dev/null &
sleep 2.5`
        : `setsid bash -c ${q(need(p.command, "url or command", "open"))} >/dev/null 2>&1 < /dev/null &\nsleep 2.5`;
      break;
    case "click":
    case "double_click":
    case "right_click":
      act = input("click", ...xy(), p.action === "right_click" ? 3 : 1, p.action === "double_click" ? 2 : 1);
      break;
    case "move":
      act = input("move", ...xy());
      break;
    case "drag":
      act = input("drag", ...xy(), Math.round(need(p.to_x, "to_x", "drag")), Math.round(need(p.to_y, "to_y", "drag")));
      break;
    case "type":
      act = input("type", need(p.text, "text", "type"));
      break;
    case "key":
      act = input("key", ...need(p.keys, "keys", "key").split(/\s+/).filter(Boolean));
      break;
    case "scroll":
      act = input("scroll", ...xy(), Math.round(p.amount ?? 3));
      break;
    case "wait":
      act = `sleep ${Math.min(30, p.seconds ?? 1)}`;
      break;
  }
  return `set -e
export DISPLAY=${DISPLAY} HOME=${HOME}
if [ ! -S /tmp/.X11-unix/X${DISPLAY.slice(1)} ]; then
  setsid Xvfb ${DISPLAY} -screen 0 ${WIDTH}x${HEIGHT}x24 -nolisten tcp >/dev/null 2>&1 < /dev/null &
  for i in $(seq 50); do [ -S /tmp/.X11-unix/X${DISPLAY.slice(1)} ] && break; sleep 0.1; done
  [ -S /tmp/.X11-unix/X${DISPLAY.slice(1)} ] || { echo "the virtual desktop (Xvfb) didn't start: is it installed?" >&2; exit 1; }
fi
if [ -e "\${UI_VIDEO_DIR:-/tmp/ui-video}/recording" ]; then ${HOME}/.agents/skills/ui-video/scripts/ui-video step ${q(p.title)} || true; fi
${act}
${p.action !== "screenshot" && p.action !== "wait" ? "sleep 0.6" : ""}
ffmpeg -nostdin -loglevel error -y -f x11grab -video_size ${WIDTH}x${HEIGHT} -i ${DISPLAY} -frames:v 1 ${SHOT}`;
}

