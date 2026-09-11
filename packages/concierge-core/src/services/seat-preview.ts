/** Read-only seat selection. Each proposed seat is free and priced for its actual area. */
export type PreviewSeat = {
  row: string;
  number: string;
  areaCategoryCode: string;
  rowIndex: number;
  columnIndex: number;
};
export function previewSeats(
  layout: Record<string, any>,
  count: number,
  preference = "middle",
  exact?: { row: string; number: string }[],
  near?: { row: string; number: string }[],
): PreviewSeat[] | null {
  const rows = (layout.Areas ?? [])
    .flatMap((area: any) =>
      (area.Rows ?? []).map((row: any) => ({
        row: String(row.PhysicalName),
        rowIndex: Number(row.RowIndexZeroBased ?? 0),
        areaCategoryCode: String(area.AreaCategoryCode),
        free: (row.Seats ?? [])
          .filter((seat: any) => seat.Status === 0 && ![1, 3].includes(Number(seat.SeatStyle ?? 0)))
          .map((seat: any) => ({
            number: String(seat.Id),
            columnIndex: Number(seat.Position?.ColumnIndex ?? 0),
          })),
      })),
    )
    .sort((a: any, b: any) => a.rowIndex - b.rowIndex) as {
    row: string;
    rowIndex: number;
    areaCategoryCode: string;
    free: { number: string; columnIndex: number }[];
  }[];
  const seat = (row: (typeof rows)[number], value: (typeof rows)[number]["free"][number]): PreviewSeat => ({
    row: row.row,
    rowIndex: row.rowIndex,
    areaCategoryCode: row.areaCategoryCode,
    ...value,
  });
  if (exact) {
    if (exact.length !== count || new Set(exact.map((s) => `${s.row}:${s.number}`)).size !== count)
      return null;
    const selected = exact.map((s) => {
      const row = rows.find((r) => r.row === s.row);
      const value = row?.free.find((v) => v.number === s.number);
      return row && value ? seat(row, value) : null;
    });
    return selected.every((s): s is PreviewSeat => s !== null) ? selected : null;
  }
  const maxRow = Math.max(0, ...rows.map((row) => row.rowIndex));
  const targetRow = near?.length
    ? (rows.find((r) => r.row === near[0]!.row)?.rowIndex ?? maxRow * 0.55)
    : preference === "front"
      ? maxRow * 0.2
      : preference === "back"
        ? maxRow * 0.85
        : maxRow * 0.55;
  const nearColumns = near?.flatMap(
    (seat) =>
      rows
        .find((r) => r.row === seat.row)
        ?.free.filter((s) => s.number === seat.number)
        .map((s) => s.columnIndex) ?? [],
  );
  const center = nearColumns?.length
    ? nearColumns.reduce((a, b) => a + b, 0) / nearColumns.length
    : (Number(layout.ColumnCount ?? 20) - 1) / 2;
  const choices: { seats: PreviewSeat[]; score: number }[] = [];
  for (const row of rows) {
    const free = [...row.free].sort((a, b) => a.columnIndex - b.columnIndex);
    for (let i = 0; i + count <= free.length; i++) {
      const run = free.slice(i, i + count);
      if (run.at(-1)!.columnIndex - run[0]!.columnIndex !== count - 1) continue;
      const atAisle =
        i === 0 ||
        i + count === free.length ||
        free[i - 1]!.columnIndex !== run[0]!.columnIndex - 1 ||
        free[i + count]!.columnIndex !== run.at(-1)!.columnIndex + 1;
      const score =
        Math.abs(row.rowIndex - targetRow) * 100 +
        Math.abs((run[0]!.columnIndex + run.at(-1)!.columnIndex) / 2 - center) +
        (preference === "aisle" && !atAisle ? 10000 : 0);
      choices.push({ seats: run.map((s) => seat(row, s)), score });
    }
  }
  return choices.sort((a, b) => a.score - b.score)[0]?.seats ?? null;
}

export function pricePreviewSeats(
  seats: PreviewSeat[],
  adults: number,
  children: number,
  types: Record<string, any>[],
  member: boolean,
) {
  const tickets: { TicketTypeCode: string; Qty: number }[] = [];
  const lines = seats.map((seat, index) => {
    const isChild = index >= adults && children > 0;
    const available = types.filter(
      (t) =>
        String(t.AreaCategoryCode) === seat.areaCategoryCode &&
        (!t.IsAvailableForLoyaltyMembersOnly || member),
    );
    const exact = available.filter((t) => !!t.IsChildOnlyTicket === isChild);
    const candidates = exact.length ? exact : isChild ? available.filter((t) => !t.IsChildOnlyTicket) : [];
    const ticket = [...candidates].sort((a, b) => a.PriceInCents - b.PriceInCents)[0];
    if (!ticket || !Number.isSafeInteger(ticket.PriceInCents) || ticket.PriceInCents < 0) return null;
    const group = tickets.find((t) => t.TicketTypeCode === ticket.TicketTypeCode);
    if (group) group.Qty++;
    else tickets.push({ TicketTypeCode: ticket.TicketTypeCode, Qty: 1 });
    return {
      ...seat,
      ticketTypeCode: ticket.TicketTypeCode,
      description: ticket.Description,
      priceCents: ticket.PriceInCents,
      child: isChild,
    };
  });
  if (lines.some((line) => !line)) return null;
  return {
    lines: lines as NonNullable<(typeof lines)[number]>[],
    tickets,
    ticketsCents: lines.reduce((total, line) => total + line!.priceCents, 0),
  };
}
