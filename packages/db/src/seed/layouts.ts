import type { SeatLayoutTemplate } from "../schema/commerce.js";

type Spec = {
  id: string;
  experience: string;
  name: string;
  rows: number;
  cols: number;
  aisleAfter?: number[]; // column indexes after which an aisle gap exists
  premiumRows?: number; // N rows in the middle block are area 1 (Premium)
  preferredRows?: number; // last N rows (back) are area 3 (Preferred View)
  sofa?: boolean;
  wheelchairSeats?: [row: number, col: number][];
};

const SPECS: Spec[] = [
  {
    id: "STD-M",
    experience: "Standard",
    name: "Standard 12x16",
    rows: 12,
    cols: 16,
    aisleAfter: [3, 11],
    premiumRows: 3,
    preferredRows: 2,
    wheelchairSeats: [
      [0, 0],
      [0, 15],
    ],
  },
  {
    id: "STD-L",
    experience: "Standard",
    name: "Standard 14x20",
    rows: 14,
    cols: 20,
    aisleAfter: [4, 14],
    premiumRows: 4,
    preferredRows: 3,
    wheelchairSeats: [
      [0, 0],
      [0, 19],
    ],
  },
  {
    id: "MAX-L",
    experience: "MAX",
    name: "MAX 16x22",
    rows: 16,
    cols: 22,
    aisleAfter: [5, 15],
    premiumRows: 4,
    preferredRows: 4,
    wheelchairSeats: [
      [0, 0],
      [0, 21],
    ],
  },
  {
    id: "IMAX-L",
    experience: "IMAX",
    name: "IMAX 18x26",
    rows: 18,
    cols: 26,
    aisleAfter: [6, 18],
    premiumRows: 5,
    preferredRows: 4,
    wheelchairSeats: [
      [0, 0],
      [0, 25],
    ],
  },
  {
    id: "GOLD-S",
    experience: "GOLD",
    name: "GOLD recliners 6x8",
    rows: 6,
    cols: 8,
    aisleAfter: [3],
    wheelchairSeats: [[0, 0]],
  },
  {
    id: "KIDS-M",
    experience: "KIDS",
    name: "KIDS 9x12",
    rows: 9,
    cols: 12,
    aisleAfter: [5],
    wheelchairSeats: [[0, 0]],
  },
  { id: "4DX-M", experience: "4DX", name: "4DX motion 8x12", rows: 8, cols: 12, aisleAfter: [3, 7] },
  {
    id: "THR-S",
    experience: "THEATRE",
    name: "THEATRE 6x10",
    rows: 6,
    cols: 10,
    aisleAfter: [4],
    wheelchairSeats: [[0, 0]],
  },
  {
    id: "PRM-M",
    experience: "Premier",
    name: "Premier 9x14",
    rows: 9,
    cols: 14,
    aisleAfter: [4, 9],
    premiumRows: 2,
    preferredRows: 2,
    wheelchairSeats: [[0, 0]],
  },
  { id: "PVW-S", experience: "Premium", name: "Premium 5x10", rows: 5, cols: 10, aisleAfter: [4] },
  { id: "CCH-S", experience: "Couch", name: "Couch 4x6 (2-seater)", rows: 4, cols: 6, sofa: true },
  { id: "OTDR-M", experience: "Outdoor", name: "Moonlight 8x12", rows: 8, cols: 12, aisleAfter: [5] },
  { id: "PRV-S", experience: "Private", name: "Private cinema 3x6", rows: 3, cols: 6 },
  { id: "OTH-M", experience: "Other", name: "Standard 10x14", rows: 10, cols: 14, aisleAfter: [3, 9] },
];

const ROWS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export function buildLayout(spec: Spec): { template: SeatLayoutTemplate; totalSeats: number } {
  const gaps = new Set(spec.aisleAfter ?? []);
  // Row order is front (A, nearest the screen) → back. Regular rows first, then Premium, then Preferred View.
  const preferredRows = spec.preferredRows ?? 0;
  const premiumRows = spec.premiumRows ?? 0;
  const regularEnd = spec.rows - premiumRows - preferredRows;
  const premiumEnd = regularEnd + premiumRows;
  const mk = (areaNumber: number, code: string, desc: string, fromRow: number, toRow: number) => {
    const rows = [];
    for (let r = fromRow; r < toRow; r++) {
      const seats = [];
      let colIdx = 0;
      let seatNo = 1;
      for (let c = 0; c < spec.cols; c++) {
        const style = spec.sofa ? 2 : spec.wheelchairSeats?.some(([wr, wc]) => wr === r && wc === c) ? 1 : 0;
        seats.push({ id: String(seatNo++), columnIndex: colIdx, style });
        colIdx++;
        if (gaps.has(c)) colIdx++; // aisle gap
      }
      rows.push({ name: ROWS[r]!, seats });
    }
    const width = spec.cols + gaps.size;
    return {
      number: areaNumber,
      areaCategoryCode: code,
      description: desc,
      rows,
      left: 0,
      top: 20 + (fromRow / spec.rows) * 80,
      width: 100,
      height: ((toRow - fromRow) / spec.rows) * 80,
      _w: width,
    };
  };
  const areas = [];
  if (regularEnd > 0) areas.push(mk(1, "0000000002", "REGULAR", 0, regularEnd));
  if (premiumRows) areas.push(mk(areas.length + 1, "0000000001", "PREMIUM", regularEnd, premiumEnd));
  if (preferredRows) areas.push(mk(areas.length + 1, "0000000003", "PREFERRED VIEW", premiumEnd, spec.rows));
  const columnCount = Math.max(...areas.map((a) => a._w));
  const cleaned = areas.map(({ _w, ...a }) => a);
  const totalSeats = spec.rows * spec.cols;
  return { template: { areas: cleaned, rowCount: spec.rows, columnCount }, totalSeats };
}

export const LAYOUTS = SPECS.map((s) => ({ ...s, ...buildLayout(s) }));
export function layoutForExperience(
  experience: string,
  sizeHint: "S" | "M" | "L" = "M",
): (typeof LAYOUTS)[number] {
  const cands = LAYOUTS.filter((l) => l.experience === experience);
  if (!cands.length) return LAYOUTS.find((l) => l.id === "OTH-M")!;
  return cands.find((l) => l.id.endsWith(`-${sizeHint}`)) ?? cands[0]!;
}
