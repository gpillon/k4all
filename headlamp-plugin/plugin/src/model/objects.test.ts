import { setPruned } from './objects';

describe('setPruned', () => {
  it('sets a value like setIn', () => {
    expect(setPruned({}, ['nodes', 'kubelet', 'maxPods'], 250)).toEqual({
      nodes: { kubelet: { maxPods: 250 } },
    });
  });

  it('removes the objects a cleared value leaves empty, and only those', () => {
    expect(
      setPruned(
        { nodes: { kubelet: { maxPods: 250 } } },
        ['nodes', 'kubelet', 'maxPods'],
        undefined
      )
    ).toEqual({});
    expect(
      setPruned(
        { features: { virt: { enabled: true, metadata: { enabled: true } } } },
        ['features', 'virt', 'metadata', 'enabled'],
        undefined
      )
    ).toEqual({ features: { virt: { enabled: true } } });
    expect(
      setPruned(
        { nodes: { kubelet: { maxPods: 250 }, iommu: true } },
        ['nodes', 'kubelet', 'maxPods'],
        undefined
      )
    ).toEqual({ nodes: { iommu: true } });
  });

  it('keeps empty objects it did not touch', () => {
    expect(setPruned({ a: {}, b: { c: 1 } }, ['b', 'c'], undefined)).toEqual({ a: {} });
  });
});
