// src/lookups/memberships.ts
// Reverse authored pairs without constraining them to a loaded entity axis.

export function reverseMemberships<K>(
  groups: ReadonlyMap<string, readonly K[]>,
): ReadonlyMap<K, readonly string[]> {
  const reverse = new Map<K, string[]>();
  for (const [group, members] of groups) {
    for (const member of new Set(members)) {
      const held = reverse.get(member);
      if (held) held.push(group);
      else reverse.set(member, [group]);
    }
  }
  for (const names of reverse.values()) names.sort((a, b) => a.localeCompare(b));
  return reverse;
}
