/*
 * IP address and CIDR parsing without BigInt (the plugin targets ES2017):
 * addresses are byte arrays, 4 bytes for IPv4 and 16 for IPv6.
 */

export type IPBytes = number[];

export function parseIPv4(text: string): IPBytes | null {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const bytes: number[] = [];
  for (const part of parts) {
    // No leading zeros: "010" is ambiguous (octal in some parsers).
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (n > 255) {
      return null;
    }
    bytes.push(n);
  }
  return bytes;
}

export function parseIPv6(text: string): IPBytes | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(text) || text.includes(':::')) {
    return null;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }
  const toGroups = (part: string): number[] | null => {
    if (part === '') {
      return [];
    }
    const groups: number[] = [];
    const items = part.split(':');
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.includes('.')) {
        // Embedded IPv4, only as the last item.
        const v4 = i === items.length - 1 ? parseIPv4(item) : null;
        if (!v4) {
          return null;
        }
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(item)) {
          return null;
        }
        groups.push(parseInt(item, 16));
      }
    }
    return groups;
  };
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !tail) {
    return null;
  }
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) {
      return null;
    }
    groups = [...head, ...new Array(missing).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) {
    return null;
  }
  const bytes: number[] = [];
  for (const g of groups) {
    bytes.push(g >> 8, g & 0xff);
  }
  return bytes;
}

export function parseIP(text: string): IPBytes | null {
  const trimmed = text.trim();
  return parseIPv4(trimmed) ?? parseIPv6(trimmed);
}

export function isIP(text: string): boolean {
  return parseIP(text) !== null;
}

export interface CIDR {
  address: IPBytes;
  prefix: number;
}

/** "10.100.0.1/18" style; host bits may be set (k4all's default pod network has them). */
export function parseCIDR(text: string): CIDR | null {
  const [addr, prefixText, extra] = text.trim().split('/');
  if (extra !== undefined || prefixText === undefined || !/^\d{1,3}$/.test(prefixText)) {
    return null;
  }
  const address = parseIP(addr);
  if (!address) {
    return null;
  }
  const prefix = Number(prefixText);
  if (prefix > address.length * 8) {
    return null;
  }
  return { address, prefix };
}

export function cidrContains(cidr: CIDR, ip: IPBytes): boolean {
  if (cidr.address.length !== ip.length) {
    return false;
  }
  let bits = cidr.prefix;
  for (let i = 0; i < ip.length && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((cidr.address[i] & mask) !== (ip[i] & mask)) {
      return false;
    }
    bits -= take;
  }
  return true;
}

export function sameIP(a: string, b: string): boolean {
  const pa = parseIP(a);
  const pb = parseIP(b);
  return !!pa && !!pb && pa.length === pb.length && pa.every((byte, i) => byte === pb[i]);
}
