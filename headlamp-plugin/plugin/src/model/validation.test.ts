import { defaultClusterConfig } from './fixtures';
import { cidrContains, isIP, parseCIDR, parseIP, sameIP } from './net';
import { setIn } from './objects';
import { setTraefik } from './settings';
import {
  hasErrors,
  issuesFor,
  overrideWarnings,
  parseValuesYaml,
  validateDeviceName,
  validateHelmArg,
  validateSettings,
} from './validation';

describe('IP parsing', () => {
  it.each([
    '192.168.1.240',
    '0.0.0.0',
    '255.255.255.255',
    '::1',
    'fe80::1',
    '2001:db8::10',
    '::ffff:10.0.0.1',
  ])('accepts %s', ip => expect(isIP(ip)).toBe(true));

  it.each([
    '',
    '256.1.1.1',
    '1.2.3',
    '01.2.3.4',
    '1.2.3.4/24',
    'fe80:::1',
    '1::2::3',
    'example.com',
    '2001:db8::g',
  ])('rejects "%s"', ip => expect(isIP(ip)).toBe(false));

  it('compares IPv6 spellings by value', () => {
    expect(sameIP('2001:db8::1', '2001:0db8:0:0:0:0:0:1')).toBe(true);
    expect(parseIP('::')).toEqual(new Array(16).fill(0));
  });

  it('handles CIDRs with host bits set, like the k4all pod network default', () => {
    const cidr = parseCIDR('10.100.0.1/18')!;
    expect(cidrContains(cidr, parseIP('10.100.63.255')!)).toBe(true);
    expect(cidrContains(cidr, parseIP('10.100.64.0')!)).toBe(false);
    expect(cidrContains(parseCIDR('fd00::/8')!, parseIP('fd12::1')!)).toBe(true);
    expect(cidrContains(cidr, parseIP('fd12::1')!)).toBe(false);
    expect(parseCIDR('10.0.0.0/33')).toBeNull();
  });
});

describe('validateSettings', () => {
  const spec = () => defaultClusterConfig().spec!;

  it('accepts the installer defaults', () => {
    expect(validateSettings(spec())).toEqual([]);
  });

  it('rejects a malformed Traefik IP', () => {
    const issues = validateSettings(setTraefik(spec(), { dedicatedIP: '192.168.1' }));
    expect(hasErrors(issues)).toBe(true);
    expect(issuesFor(issues, 'traefikIP')[0].message).toMatch(/not an IPv4 or IPv6 address/);
  });

  it('rejects addresses inside the pod or service network', () => {
    expect(
      issuesFor(
        validateSettings(setTraefik(spec(), { dedicatedIP: '10.100.0.50' })),
        'traefikIP'
      )[0].message
    ).toMatch(/pod network/);
    expect(
      issuesFor(validateSettings(setTraefik(spec(), { dedicatedIP: '10.96.0.10' })), 'traefikIP')[0]
        .message
    ).toMatch(/service network/);
  });

  it('rejects the control plane virtual IP', () => {
    const withVip = setIn(spec(), ['cluster', 'ha', 'apiControlEndpoint'], '192.168.1.5');
    const issues = validateSettings(setTraefik(withVip, { dedicatedIP: '192.168.1.5' }));
    expect(issuesFor(issues, 'traefikIP').map(i => i.severity)).toEqual(['error']);
  });

  it('warns, without blocking, when the IP is a node address', () => {
    const issues = validateSettings(setTraefik(spec(), { dedicatedIP: '192.168.1.10' }), {
      nodeIPs: ['192.168.1.10'],
    });
    expect(hasErrors(issues)).toBe(false);
    expect(issues[0].severity).toBe('warning');
  });

  it('rejects the same IP for Traefik and the Cilium ingress', () => {
    let s = setIn(spec(), ['networking', 'cni', 'type'], 'cilium');
    s = setTraefik(s, { dedicatedIP: '192.168.1.240' });
    s = setIn(s, ['ingress', 'cilium', 'dedicatedIP'], '192.168.1.240');
    expect(
      issuesFor(validateSettings(s), 'ciliumIngressIP').some(i => i.severity === 'error')
    ).toBe(true);
  });

  it('warns when a Cilium ingress IP is set on a Calico cluster', () => {
    const s = setIn(spec(), ['ingress', 'cilium', 'dedicatedIP'], '192.168.1.241');
    expect(issuesFor(validateSettings(s), 'ciliumIngressIP')[0].severity).toBe('warning');
  });

  it('checks Cilium devices', () => {
    const s = setIn(
      spec(),
      ['networking', 'cni', 'cilium', 'additionalDevices'],
      ['eth1', 'eth1', 'bad name', 'ovs-bridge']
    );
    const messages = issuesFor(validateSettings(s), 'ciliumDevices').map(
      i => `${i.severity}: ${i.message}`
    );
    expect(messages).toEqual([
      'error: "eth1" is listed twice.',
      'error: "bad name" contains a space or "/".',
      'warning: ovs-bridge is added automatically when the OVS bridge is on.',
    ]);
  });

  it('rejects an unknown emulation mode', () => {
    const s = setIn(spec(), ['features', 'virt', 'emulation'], 'maybe');
    expect(hasErrors(validateSettings(s))).toBe(true);
  });
});

describe('validateDeviceName', () => {
  it('accepts names and Cilium wildcards up to 15 characters', () => {
    expect(validateDeviceName('enp0s31f6')).toBeNull();
    expect(validateDeviceName('eth+')).toBeNull();
    expect(validateDeviceName('abcdefghijklmno')).toBeNull();
    expect(validateDeviceName('abcdefghijklmnop')).toMatch(/longer than 15/);
    expect(validateDeviceName('..')).not.toBeNull();
  });
});

describe('validateHelmArg', () => {
  it.each(['--set a=1', '--set=a.b=c', 'a=1', '--set a=1,b=2', '--set a[0].b=x'])(
    'accepts %s',
    arg => expect(validateHelmArg(arg)).toBeNull()
  );

  it.each([
    ['', /Empty/],
    ['--set-string a=1', /only --set/],
    ['--version 1.2.3', /only --set/],
    ['--set novalue', /expected key=value/],
    ['=1', /expected key=value/],
    ['--set a b=1', /contains spaces/],
  ])('rejects "%s"', (arg, message) => expect(validateHelmArg(arg)).toMatch(message));
});

describe('parseValuesYaml', () => {
  it('treats empty text as no values', () => {
    expect(parseValuesYaml('  \n')).toEqual({ values: undefined });
    expect(parseValuesYaml('# just a comment\n')).toEqual({ values: undefined });
  });

  it('parses a mapping and keeps explicit nulls', () => {
    expect(parseValuesYaml('config:\n  baseURL: /dash\nresources: null\n')).toEqual({
      values: { config: { baseURL: '/dash' }, resources: null },
    });
  });

  it('keeps yes/no/on as strings (YAML 1.2), so values mean what they say', () => {
    expect(parseValuesYaml('a: yes\nb: on\nc: true\n').values).toEqual({
      a: 'yes',
      b: 'on',
      c: true,
    });
  });

  it('reports the line of a syntax error', () => {
    expect(parseValuesYaml('a: 1\nb: [1, 2\n').error).toMatch(/line \d/);
  });

  it('rejects lists and scalars', () => {
    expect(parseValuesYaml('- a\n- b\n').error).toMatch(/mapping/);
    expect(parseValuesYaml('42').error).toMatch(/mapping/);
  });
});

describe('overrideWarnings', () => {
  it('warns that values are ignored for non-Helm components', () => {
    expect(overrideWarnings('metallb', { a: 1 }, 'manifest')[0].message).toMatch(
      /only uses values for Helm/
    );
    expect(overrideWarnings('traefik', { a: 1 }, 'helm')).toEqual([]);
  });

  it('warns when a headlamp override would replace the plugin lists', () => {
    const issues = overrideWarnings('headlamp', { volumes: [], config: {} }, 'helm');
    expect(issues[0].message).toMatch(/drops the k4all plugin/);
  });
});
