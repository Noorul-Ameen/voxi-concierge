/** Seat occupancy helpers shared by the seed and the Vista mock (deterministic per session). */
import type { SeatLayoutTemplate } from "./schema/commerce.js";
import { prng } from "./seed/util.js";

export type SeatStatusMap = Record<string, { status: number; orderId?: string; bookingId?: string }>;
export const seatKey = (row: string, number: string) => `${row}:${number}`;

export type FlatSeat = {
  row: string;
  number: string;
  rowIndex: number;
  columnIndex: number;
  areaNumber: number;
  areaCategoryCode: string;
  style: number;
};

export function flattenLayout(layout: SeatLayoutTemplate): FlatSeat[] {
  const out: FlatSeat[] = [];
  let rowIndex = 0;
  for (const area of layout.areas) {
    for (const row of area.rows) {
      for (const seat of row.seats) {
        out.push({
          row: row.name,
          number: seat.id,
          rowIndex,
          columnIndex: seat.columnIndex,
          areaNumber: area.number,
          areaCategoryCode: area.areaCategoryCode,
          style: seat.style ?? 0,
        });
      }
      rowIndex++;
    }
  }
  return out;
}

/**
 * Generate an initial occupancy for a session. Occupancy grows as the showtime approaches and is
 * higher for weekend evenings; a 'sold out' session is filled completely.
 */
export function generateSeatState(
  cinemaId: string,
  sessionId: string,
  layout: SeatLayoutTemplate,
  opts: { soldOut?: boolean; occupancy?: number } = {},
): SeatStatusMap {
  const rnd = prng(`seat:${cinemaId}:${sessionId}`);
  const occupancy = opts.soldOut ? 1 : (opts.occupancy ?? 0.15 + rnd.next() * 0.45);
  const seats = flattenLayout(layout);
  const map: SeatStatusMap = {};
  // Sell in small clusters so the map looks realistic (pairs/quads next to each other).
  for (const s of seats) map[seatKey(s.row, s.number)] = { status: 0 };
  const byRow = new Map<string, FlatSeat[]>();
  for (const s of seats) byRow.set(s.row, [...(byRow.get(s.row) ?? []), s]);
  let toSell = Math.round(seats.length * occupancy);
  const rows = [...byRow.keys()];
  let guard = 0;
  while (toSell > 0 && guard++ < 5000) {
    const row = byRow.get(rnd.pick(rows))!;
    const size = Math.min(toSell, rnd.pick([1, 2, 2, 2, 3, 4, 4]));
    const start = rnd.int(0, Math.max(0, row.length - size));
    for (let i = 0; i < size; i++) {
      const s = row[start + i];
      if (!s) break;
      const k = seatKey(s.row, s.number);
      if (map[k]!.status === 0) {
        map[k] = { status: 1 };
        toSell--;
      }
    }
  }
  return map;
}

/** Pick `count` adjacent available seats honouring a preference. Returns [] if none. */
export function pickAdjacentSeats(
  layout: SeatLayoutTemplate,
  state: SeatStatusMap,
  count: number,
  preference: "front" | "middle" | "back" | "aisle" = "middle",
  areaCategoryCode?: string,
): FlatSeat[] {
  const seats = flattenLayout(layout).filter(
    (s) => !areaCategoryCode || s.areaCategoryCode === areaCategoryCode,
  );
  const byRow = new Map<string, FlatSeat[]>();
  for (const s of seats) byRow.set(s.row, [...(byRow.get(s.row) ?? []), s]);
  const rows = [...byRow.entries()];
  const n = rows.length;
  const order = rows
    .map(([name, rs], i) => {
      const pos = i / Math.max(1, n - 1); // 0 front .. 1 back
      const score = preference === "front" ? pos : preference === "back" ? 1 - pos : Math.abs(pos - 0.6);
      return { name, rs, score };
    })
    .sort((a, b) => a.score - b.score);
  for (const { rs } of order) {
    const sorted = [...rs].sort((a, b) => a.columnIndex - b.columnIndex);
    const mid = (sorted[0]!.columnIndex + sorted[sorted.length - 1]!.columnIndex) / 2;
    const candidates: FlatSeat[][] = [];
    for (let i = 0; i + count <= sorted.length; i++) {
      const run = sorted.slice(i, i + count);
      let ok = true;
      for (let j = 0; j < run.length; j++) {
        const s = run[j]!;
        if (state[seatKey(s.row, s.number)]?.status !== 0 || s.style === 1) ok = false;
        if (j > 0 && run[j]!.columnIndex !== run[j - 1]!.columnIndex + 1) ok = false; // must be contiguous (no aisle gap)
      }
      if (ok) candidates.push(run);
    }
    if (candidates.length) {
      candidates.sort((a, b) => {
        const ca = (a[0]!.columnIndex + a[a.length - 1]!.columnIndex) / 2;
        const cb = (b[0]!.columnIndex + b[b.length - 1]!.columnIndex) / 2;
        if (preference === "aisle") return Math.abs(ca - mid) < Math.abs(cb - mid) ? 1 : -1;
        return Math.abs(ca - mid) - Math.abs(cb - mid);
      });
      return candidates[0]!;
    }
  }
  return [];
}
