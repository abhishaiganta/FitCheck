// Car-fit estimate: the item's bounding box against the car's cargo opening and depth.
export type Box = { w: number; d: number; h: number };
export type Car = {
  make_model: string;
  cargo_w_in: number; // opening width
  cargo_h_in: number; // opening height
  cargo_d_in: number; // depth with seats up
  seats_folded_d_in: number | null;
};
export type Fit = 'fits' | 'seats_folded' | 'too_big';

/** The three ways to pick which side of the item slides in along the cargo depth. */
function orientations({ w, d, h }: Box): [face1: number, face2: number, along: number][] {
  return [[w, h, d], [d, h, w], [w, d, h]];
}

/**
 * Fits if, in some orientation, the face clears the opening (either way up) and the
 * remaining side fits the cargo depth; "seats_folded" if it only fits with the rear seats down.
 */
export function carFit(item: Box, car: Car): Fit {
  const dims = [item.w, item.d, item.h];
  if (dims.some((x) => !Number.isFinite(x) || x <= 0)) return 'too_big';
  let folded = false;
  for (const [a, b, along] of orientations(item)) {
    const clears =
      (a <= car.cargo_w_in && b <= car.cargo_h_in) || (b <= car.cargo_w_in && a <= car.cargo_h_in);
    if (!clears) continue;
    if (along <= car.cargo_d_in) return 'fits';
    if (car.seats_folded_d_in != null && along <= car.seats_folded_d_in) folded = true;
  }
  return folded ? 'seats_folded' : 'too_big';
}

const CAR_ALIASES: [RegExp, string][] = [
  [/\bcivic\b/, 'Honda Civic'], [/\bcorolla\b/, 'Toyota Corolla'], [/\bcamry\b/, 'Toyota Camry'],
  [/\bmodel[ -]?3\b/, 'Tesla Model 3'], [/\bmodel[ -]?y\b/, 'Tesla Model Y'],
  [/\brav[ -]?4\b/, 'Toyota RAV4'], [/\bcr[ -]?v\b/, 'Honda CR-V'], [/\bprius\b/, 'Toyota Prius'],
  [/\belantra\b/, 'Hyundai Elantra'], [/\bmazda[ -]?3\b/, 'Mazda3'], [/\boutback\b/, 'Subaru Outback'],
  [/\bjetta\b/, 'Volkswagen Jetta'], [/\baccord\b/, 'Honda Accord'], [/\bsentra\b/, 'Nissan Sentra'],
  [/\bwrangler\b/, 'Jeep Wrangler'],
];

/** Finds a known car in free text ("I drive a Civic"). */
export function findCarInText(text: string): string | null {
  const t = text.toLowerCase();
  for (const [re, name] of CAR_ALIASES) if (re.test(t)) return name;
  return null;
}

/** Short name for badges: "Honda Civic" -> "Civic". */
export function shortCarName(make_model: string): string {
  const parts = make_model.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : make_model;
}

/** Loose match between what the user said and a cars.make_model row. */
export function matchCar<T extends { make_model: string }>(said: string, cars: T[]): T | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const s = norm(said);
  if (!s) return null;
  return (
    cars.find((c) => norm(c.make_model) === s) ??
    cars.find((c) => norm(c.make_model).endsWith(s) || s.endsWith(norm(shortCarName(c.make_model)))) ??
    cars.find((c) => norm(c.make_model).includes(s) || s.includes(norm(shortCarName(c.make_model)))) ??
    null
  );
}
