// Pure build planner.  No network, uploads or release state changes.
// One shared merge-timestamp build per app across iOS and macOS (owner, Oct 29 2026).
// build = max(S, M + 1), a plain integer, where S is the merge stamp (the
// committer date of HEAD in America/Chicago as YYYYMMDDHHMM) and M is the
// highest first numeric component among every iOS build, every macOS build
// (expired included, all version trains, old timestamp-style builds included)
// and every extra floor.  A rebuild of the same commit still goes up because
// M includes the previous upload.  No floor and no cap.
export function nextSharedBuild({iosBuilds, macBuilds, extraFloors = [], complete, mergeStamp}) {
  if (complete !== true || !Array.isArray(iosBuilds) || !Array.isArray(macBuilds)) {
    throw new Error('complete build inventory required');
  }
  if (typeof mergeStamp !== 'string' || !/^[1-9][0-9]{11}$/.test(mergeStamp)) {
    throw new Error('malformed build inventory: bad mergeStamp');
  }
  if (!Array.isArray(extraFloors)) throw new Error('malformed build inventory');
  const floors = [];
  for (const floor of extraFloors) {
    if (typeof floor === 'number') {
      if (!Number.isSafeInteger(floor) || floor < 0) {
        throw new Error('malformed build inventory');
      }
      floors.push(BigInt(floor));
    } else if (typeof floor === 'string') {
      if (!/^[0-9]{1,18}$/.test(floor)) throw new Error('malformed build inventory');
      floors.push(BigInt(floor));
    } else {
      throw new Error('malformed build inventory');
    }
  }
  // Validate everything before computing; malformed evidence is never ignored.
  const re = /^[0-9]+(\.[0-9]+){0,2}$/;
  for (const value of [...iosBuilds, ...macBuilds]) {
    if (typeof value !== 'string' || !re.test(value)) throw new Error('malformed build inventory');
  }
  const stamp = BigInt(mergeStamp);
  let max = null;
  for (const value of [...iosBuilds, ...macBuilds]) {
    const first = BigInt(value.split('.')[0]);
    if (max === null || first > max) max = first;
  }
  for (const floor of floors) {
    if (max === null || floor > max) max = floor;
  }
  const next = max === null ? stamp : (max + 1n > stamp ? max + 1n : stamp);
  return {build: String(next)};
}
