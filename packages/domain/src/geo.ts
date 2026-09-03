/** Haversine distance in km. */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function nearest<T extends { latitude: string | null; longitude: string | null }>(items: T[], lat: number, lng: number, limit = 3): (T & { distanceKm: number })[] {
  return items
    .filter((c) => c.latitude && c.longitude)
    .map((c) => ({ ...c, distanceKm: Math.round(distanceKm(lat, lng, Number(c.latitude), Number(c.longitude)) * 10) / 10 }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}
