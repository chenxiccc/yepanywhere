function mergeScenarioTargets(portable, capacityOverride) {
  const browserBudgets = new Set([
    ...Object.keys(portable?.browser ?? {}),
    ...Object.keys(capacityOverride?.browser ?? {}),
  ]);
  return {
    server: {
      ...portable?.server,
      ...capacityOverride?.server,
    },
    browserProcess: {
      ...portable?.browserProcess,
      ...capacityOverride?.browserProcess,
    },
    browser: Object.fromEntries(
      [...browserBudgets].map((budget) => [
        budget,
        {
          ...portable?.browser?.[budget],
          ...capacityOverride?.browser?.[budget],
        },
      ]),
    ),
  };
}

export function selectRatchetTargets(
  ratchets,
  { capacityKey, driver, scenario },
) {
  const portable = ratchets.drivers?.[driver]?.scenarios?.[scenario];
  const capacityRegistration = ratchets.capacityOverrides?.[capacityKey];
  const capacityOverride =
    capacityRegistration?.drivers?.[driver]?.scenarios?.[scenario];
  return {
    targets: mergeScenarioTargets(portable, capacityOverride),
    selection: {
      capacityKey,
      capacityOverrideApplied: capacityOverride !== undefined,
      capacityRegistered: capacityRegistration !== undefined,
      targetKey:
        capacityRegistration === undefined
          ? "portable-default"
          : `capacity:${capacityKey}`,
    },
  };
}
