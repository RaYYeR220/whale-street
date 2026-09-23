import type { Address } from './types';

const ADJECTIVES = [
  'Obsidian',
  'Gilded',
  'Crimson',
  'Silent',
  'Iron',
  'Velvet',
  'Neon',
  'Arctic',
  'Copper',
  'Ivory',
  'Cobalt',
  'Scarlet',
  'Midnight',
  'Golden',
  'Hollow',
  'Lucky',
  'Rogue',
  'Stoic',
  'Feral',
  'Quiet',
  'Brazen',
  'Lunar',
  'Solar',
  'Tidal',
  'Molten',
  'Frosted',
  'Amber',
  'Onyx',
  'Jade',
  'Saffron',
  'Marble',
  'Granite',
  'Crystal',
  'Electric',
  'Phantom',
  'Royal',
  'Rusty',
  'Savage',
  'Humble',
  'Nimble',
  'Patient',
  'Restless',
  'Reckless',
  'Steady',
  'Wild',
  'Ancient',
  'Northern',
  'Southern',
  'Eastern',
  'Western',
  'Silver',
  'Emerald',
  'Sapphire',
  'Topaz',
  'Platinum',
  'Titanium',
  'Cosmic',
  'Atomic',
  'Rapid',
  'Heavy',
  'Bold',
  'Grim',
  'Merry',
  'Vivid',
] as const;

const CREATURES = [
  'Octopus',
  'Barracuda',
  'Marlin',
  'Orca',
  'Narwhal',
  'Stingray',
  'Swordfish',
  'Squid',
  'Mantis',
  'Falcon',
  'Hawk',
  'Raven',
  'Heron',
  'Pelican',
  'Albatross',
  'Condor',
  'Jackal',
  'Wolf',
  'Lynx',
  'Panther',
  'Jaguar',
  'Cobra',
  'Viper',
  'Python',
  'Gecko',
  'Iguana',
  'Badger',
  'Otter',
  'Beaver',
  'Mole',
  'Hare',
  'Stag',
  'Bison',
  'Rhino',
  'Hippo',
  'Walrus',
  'Seal',
  'Penguin',
  'Puffin',
  'Crab',
  'Lobster',
  'Shrimp',
  'Urchin',
  'Eel',
  'Pike',
  'Carp',
  'Trout',
  'Salmon',
  'Tuna',
  'Moray',
  'Manatee',
  'Dolphin',
  'Porpoise',
  'Beluga',
  'Hammerhead',
  'Mako',
  'Tiger',
  'Lion',
  'Bear',
  'Fox',
  'Owl',
  'Kraken',
  'Leviathan',
  'Mongoose',
] as const;

const SUFFIXES = [
  'Holdings',
  'Capital',
  'Partners',
  'Group',
  'Trust',
  'Industries',
  'Ventures',
  'Syndicate',
] as const;

/** FNV-1a 32-bit hash. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CompanyIdentity {
  name: string;
  /** Ordered preferences; the engine takes the first one not already used. */
  tickerCandidates: string[];
  logoSeed: number;
}

export function companyIdentity(address: Address): CompanyIdentity {
  const seed = hash32(address.toLowerCase());
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

  const adjective = pick(ADJECTIVES);
  const creature = pick(CREATURES);
  const suffix = pick(SUFFIXES);

  const adj = adjective.toUpperCase();
  const cre = creature.toUpperCase();
  const suf = suffix.toUpperCase();
  const a = adj.charAt(0);
  const c = cre.charAt(0);
  const s = suf.charAt(0);

  const candidates: string[] = [];
  const push = (t: string) => {
    if (/^[A-Z][A-Z0-9]{2,3}$/.test(t) && !candidates.includes(t)) candidates.push(t);
  };
  push(a + c + s);
  push(a + cre.slice(0, 2));
  push(adj.slice(0, 2) + c);
  push(a + c + s + cre.charAt(1));
  push(a + cre.slice(0, 3));
  push(adj.slice(0, 2) + cre.slice(0, 2));
  for (let i = 2; i <= 9; i++) push(a + c + s + String(i));

  return {
    name: `${adjective} ${creature} ${suffix}`,
    tickerCandidates: candidates,
    logoSeed: seed,
  };
}
