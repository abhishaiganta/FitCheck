export const CATEGORIES = [
  'side_table', 'nightstand', 'coffee_table', 'desk_lamp', 'floor_lamp', 'stool',
  'ottoman', 'accent_chair', 'dining_chair', 'dresser', 'bookshelf', 'desk',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, [singular: string, plural: string]> = {
  side_table: ['side table', 'side tables'],
  nightstand: ['nightstand', 'nightstands'],
  coffee_table: ['coffee table', 'coffee tables'],
  desk_lamp: ['desk lamp', 'desk lamps'],
  floor_lamp: ['floor lamp', 'floor lamps'],
  stool: ['stool', 'stools'],
  ottoman: ['ottoman', 'ottomans'],
  accent_chair: ['accent chair', 'accent chairs'],
  dining_chair: ['dining chair', 'dining chairs'],
  dresser: ['dresser', 'dressers'],
  bookshelf: ['bookshelf', 'bookshelves'],
  desk: ['desk', 'desks'],
};

/** Phrase -> categories. Longer phrases are matched first, and matched text is consumed. */
export const CATEGORY_SYNONYMS: [RegExp, Category[]][] = [
  [/\b(desk|table|task|reading|study|bedside)[ -]?(lamp|light)s?\b/, ['desk_lamp']],
  [/\b(floor|standing|tall|arc|torchiere)[ -]?(lamp|light)s?\b/, ['floor_lamp']],
  [/\b(lamp|light|lighting)s?\b/, ['desk_lamp', 'floor_lamp']],
  [/\b(night[ -]?stand|bed[ -]?side table|bed[ -]?table)s?\b/, ['nightstand']],
  [/\b(coffee|cocktail)[ -]?tables?\b/, ['coffee_table']],
  [/\b(side|end|accent|small|little)[ -]?tables?\b/, ['side_table']],
  [/\b(book[ -]?(shelf|shelves|case|cases)|shelving|shelf|shelves)\b/, ['bookshelf']],
  [/\b(dresser|chest of drawers|drawers)s?\b/, ['dresser']],
  [/\b(ottoman|pouf|pouffe|foot[ -]?(stool|rest))s?\b/, ['ottoman']],
  [/\b(bar[ -]?stool|step[ -]?stool|stool)s?\b/, ['stool']],
  [/\b(dining|kitchen|wooden)[ -]?chairs?\b/, ['dining_chair']],
  [/\b(accent|arm|lounge|reading|comfy|cozy)[ -]?chairs?\b|\barmchairs?\b/, ['accent_chair']],
  [/\bdesk[ -]?chairs?\b/, ['dining_chair', 'accent_chair']],
  [/\bchairs?\b/, ['accent_chair', 'dining_chair']],
  [/\b(writing|study|computer|standing)?[ -]?desks?\b/, ['desk']],
  [/\btables?\b/, ['side_table', 'coffee_table']],
];

export const isCategory = (s: string): s is Category => (CATEGORIES as readonly string[]).includes(s);
