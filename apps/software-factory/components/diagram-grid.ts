/** The landing diagram as a grid of character cells, without React. */
export type Tone = "line" | "ink" | "on";
export type Icon = "slack" | "github";
/** A logo takes two cells: the first draws it, the second is covered by it. */
export type Cell = { char: string; tone: Tone; icon?: Icon; covered?: true };
type Place = "slack" | "agent" | "github";
type Point = [x: number, y: number];

/** Monochrome marks: GitHub's from Primer Octicons (MIT), Slack's from Material Design Icons (Apache-2.0). */
export const ICONS: Record<Icon, { viewBox: string; d: string }> = {
  github: {
    viewBox: "0 0 16 16",
    d: "M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656",
  },
  slack: {
    viewBox: "0 0 24 24",
    d: "M6,15A2,2 0 0,1 4,17A2,2 0 0,1 2,15A2,2 0 0,1 4,13H6V15M7,15A2,2 0 0,1 9,13A2,2 0 0,1 11,15V20A2,2 0 0,1 9,22A2,2 0 0,1 7,20V15M9,7A2,2 0 0,1 7,5A2,2 0 0,1 9,3A2,2 0 0,1 11,5V7H9M9,8A2,2 0 0,1 11,10A2,2 0 0,1 9,12H4A2,2 0 0,1 2,10A2,2 0 0,1 4,8H9M17,10A2,2 0 0,1 19,8A2,2 0 0,1 21,10A2,2 0 0,1 19,12H17V10M16,10A2,2 0 0,1 14,12A2,2 0 0,1 12,10V5A2,2 0 0,1 14,3A2,2 0 0,1 16,5V10M14,18A2,2 0 0,1 16,20A2,2 0 0,1 14,22A2,2 0 0,1 12,20V18H14M14,17A2,2 0 0,1 12,15A2,2 0 0,1 14,13H19A2,2 0 0,1 21,15A2,2 0 0,1 19,17H14Z",
  },
};

/**
 * One PR's whole life in one board thread. Each event happens in one place, goes
 * up the wire into the board's log, and fans out to the other two places.
 */
const EVENTS: {
  id: number;
  from: Place;
  author: string;
  text: string;
  /** The PR root's labels once the event lands, when it changes them. */
  labels?: string;
  /** How each place shows it. */
  rows: Record<Place, string>;
}[] = [
  {
    id: 812,
    from: "github",
    author: "julian (github)",
    text: "PR #42 fix safari",
    labels: "state=open",
    rows: { github: "julian opened #42", slack: "julian  PR #42", agent: "#812 julian: PR #42" },
  },
  {
    id: 813,
    from: "slack",
    author: "monto (slack)",
    text: "can you check iOS too?",
    rows: { slack: "monto   check iOS?", github: "monto: check iOS?", agent: "#813 monto: check iOS?" },
  },
  {
    id: 815,
    from: "agent",
    author: "claude via julian",
    text: "fixed iOS too",
    rows: { agent: "#815 claude: fixed iOS", slack: "claude  fixed iOS", github: "claude: fixed iOS" },
  },
  {
    id: 816,
    from: "github",
    author: "andrew (github)",
    text: "approved",
    labels: "state=open review=approved",
    rows: { github: "andrew approved", slack: "andrew  approved", agent: "#816 andrew: approved" },
  },
  {
    id: 817,
    from: "github",
    author: "martin (github)",
    text: "merged",
    labels: "state=merged review=approved",
    rows: { github: "martin merged #42", slack: "martin  merged", agent: "#817 martin: merged" },
  },
];

const PLACES: Place[] = ["slack", "agent", "github"];
const WIDTH = 76;
/** Each place's box, and where its wire drops into the top border, clear of the title. */
const BOXES: Record<Place, { x: number; w: number; title: string; icon?: Icon; right?: true; stem: number }> = {
  slack: { x: 0, w: 22, title: "slack #prs", icon: "slack", stem: 18 },
  agent: { x: 24, w: 28, title: "agent", stem: 38 },
  github: { x: 54, w: 22, title: "github #42", icon: "github", right: true, stem: 57 },
};
const BOARD = { x: 11, w: 55, title: "board · prs" };
/** Where the board's own wire meets the bus. */
const HUB = 38;

/** Under the log, a rule, then the PR root's labels. */
const RULE_Y = EVENTS.length + 1;
const LABELS_Y = EVENTS.length + 2;
const BOARD_BOTTOM = EVENTS.length + 3;
const BUS = BOARD_BOTTOM + 2;
const PLACES_Y = BUS + 2;
const HEIGHT = PLACES_Y + EVENTS.length + 2;

/** The wire from a place up to the board, cell by cell. */
function wire(place: Place): Point[] {
  const { stem } = BOXES[place];
  const cells: Point[] = [
    [stem, PLACES_Y],
    [stem, PLACES_Y - 1],
  ];
  const step = Math.sign(HUB - stem);
  for (let x = stem; x !== HUB; x += step) cells.push([x, BUS]);
  cells.push([HUB, BUS], [HUB, BUS - 1], [HUB, BOARD_BOTTOM]);
  return cells;
}

// In ticks: an event shows where it happened, rides the wire up into the board,
// then out to the other places, and settles.
const APPEAR = 5;
const HOLD = 5;
const SETTLE = 10;
const TRAIL = 4;
/** A pulse runs along the wire in heavy strokes. */
const HEAVY: Record<string, string> = { "─": "━", "│": "┃", "┼": "╋", "┬": "┳", "┴": "┻", "┌": "┏", "┐": "┓" };
export const TICK_MS = 32;

/** When each event reaches each place. */
const TIMELINE = (() => {
  let start = 0;
  return EVENTS.map((event) => {
    const up = wire(event.from);
    const board = start + APPEAR + up.length;
    const downs = PLACES.filter((place) => place !== event.from).map((place) => {
      const path = [...wire(place)].reverse();
      return { place, path, start: board + HOLD, arrive: board + HOLD + path.length };
    });
    const timing = { start, up, board, downs, end: Math.max(...downs.map((down) => down.arrive)) + SETTLE };
    start = timing.end;
    return timing;
  });
})();
export const LOOP = TIMELINE.at(-1)!.end + 40;

export function draw(tick: number): Cell[][] {
  const grid = Array.from({ length: HEIGHT }, () =>
    Array.from({ length: WIDTH }, (): Cell => ({ char: " ", tone: "line" })),
  );
  const put = (x: number, y: number, text: string, tone: Tone): void => {
    [...text].forEach((char, i) => {
      const cell = grid[y]?.[x + i];
      if (cell) Object.assign(cell, { char, tone });
    });
  };
  const light = ([x, y]: Point): void => {
    const cell = grid[y]?.[x];
    if (cell) Object.assign(cell, { char: HEAVY[cell.char] ?? cell.char, tone: "on" });
  };
  const icons = new Map<Place, Cell>();
  const box = (x: number, y: number, w: number, h: number, title: string, right = false, place?: Place): void => {
    const icon = place && BOXES[place].icon;
    // A logo leads its title: two cells for it, then a space.
    const label = icon ? `   ${title}` : title;
    const rule = "─".repeat(w - label.length - 5);
    put(x, y, right ? `┌${rule} ${label} ─┐` : `┌─ ${label} ${rule}┐`, "line");
    if (icon) {
      const start = right ? x + w - label.length - 3 : x + 3;
      const [first, second] = [grid[y]![start]!, grid[y]![start + 1]!];
      Object.assign(first, { icon, tone: "ink" });
      second.covered = true;
      icons.set(place, first);
    }
    for (let row = y + 1; row < y + h - 1; row++) {
      put(x, row, "│", "line");
      put(x + w - 1, row, "│", "line");
    }
    put(x, y + h - 1, `└${"─".repeat(w - 2)}┘`, "line");
  };

  // The board, its wire, the bus, and the three places hanging off it.
  box(BOARD.x, 0, BOARD.w, BOARD_BOTTOM + 1, BOARD.title);
  put(BOARD.x, RULE_Y, `├${"─".repeat(BOARD.w - 2)}┤`, "line");
  put(HUB, BOARD_BOTTOM, "┬", "line");
  put(HUB, BUS - 1, "│", "line");
  const left = BOXES.slack.stem;
  const right = BOXES.github.stem;
  put(left, BUS, `┌${"─".repeat(right - left - 1)}┐`, "line");
  put(HUB, BUS, "┼", "line");
  for (const place of PLACES) {
    const { x, w, title, right: alignRight, stem } = BOXES[place];
    put(stem, BUS + 1, "│", "line");
    box(x, PLACES_Y, w, EVENTS.length + 2, title, alignRight, place);
    put(stem, PLACES_Y, "┴", "line");
  }

  let labels: { text: string; lit: boolean } | undefined;
  EVENTS.forEach((event, i) => {
    const timing = TIMELINE[i]!;
    if (tick < timing.start) return;
    const tone: Tone = tick < timing.end ? "on" : "ink";
    const row = (place: Place): void => {
      put(BOXES[place].x + 2, PLACES_Y + 1 + i, event.rows[place], tone);
      // A place's logo lights up while something is happening there.
      const icon = icons.get(place);
      if (icon && tone === "on") icon.tone = "on";
    };

    row(event.from);
    const pulse = (path: Point[], start: number): void => {
      const head = tick - start;
      for (let at = Math.max(0, head - TRAIL + 1); at <= head && at < path.length; at++) light(path[at]!);
    };
    pulse(timing.up, timing.start + APPEAR);

    if (tick < timing.board) return;
    put(BOARD.x + 2, i + 1, `#${event.id}`, tone);
    put(BOARD.x + 8, i + 1, event.author, tone);
    put(BOARD.x + 26, i + 1, event.text, tone === "on" ? "on" : "line");
    if (event.labels) labels = { text: event.labels, lit: tick < timing.end };

    for (const down of timing.downs) {
      pulse(down.path, down.start);
      if (tick >= down.arrive) row(down.place);
    }
  });
  put(BOARD.x + 2, LABELS_Y, "labels on #812:", "line");
  if (labels) put(BOARD.x + 18, LABELS_Y, labels.text, labels.lit ? "on" : "ink");
  return grid;
}

export type Run = { text: string; tone: Tone; cell?: true } | { icon: Icon; tone: Tone };

/** The pulse's heavy strokes, which many monospace fonts (Liberation Mono, Consolas) don't have. */
const FALLBACK = new Set(Object.values(HEAVY));

/**
 * A row of cells as runs of text that share a tone. Each logo, and each heavy
 * stroke, gets a run of its own, rendered one cell wide: a fallback font draws
 * the strokes wider, and that would widen the row and shift the whole diagram.
 */
export function runs(row: Cell[]): Run[] {
  const out: Run[] = [];
  for (const { char, tone, icon, covered } of row) {
    if (covered) continue;
    const last = out.at(-1);
    if (icon) out.push({ icon, tone });
    else if (FALLBACK.has(char)) out.push({ text: char, tone, cell: true });
    else if (last && "text" in last && !last.cell && last.tone === tone) last.text += char;
    else out.push({ text: char, tone });
  }
  return out;
}
