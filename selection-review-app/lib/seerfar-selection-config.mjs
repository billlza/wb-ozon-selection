/** Loads the versioned Seerfar selection profiles and season calendar shipped in data/seerfar-selection/. */
import { readFile } from 'node:fs/promises';
import { SeerfarSelectionPlanError, assertSeasonCalendar, assertStoreSelectionProfile } from './seerfar-selection-plan.mjs';

const DEFAULT_DIRECTORY = new URL('../data/seerfar-selection/', import.meta.url);

export async function loadSeerfarSelectionConfig({ directory = DEFAULT_DIRECTORY } = {}) {
  const read = async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'));
  const profilesFile = await read('store-profiles.json');
  if (profilesFile?.schemaVersion !== 'seerfar-store-selection-profiles-v1' || !Array.isArray(profilesFile.profiles)) {
    throw new SeerfarSelectionPlanError('CONFIG_INVALID', 'store-profiles.json');
  }
  const profiles = {};
  for (const raw of profilesFile.profiles) {
    const profile = assertStoreSelectionProfile(raw);
    if (Object.hasOwn(profiles, profile.targetStore)) throw new SeerfarSelectionPlanError('CONFIG_INVALID', `two profiles for ${profile.targetStore}`);
    profiles[profile.targetStore] = profile;
  }
  return { profiles, calendar: assertSeasonCalendar(await read('season-calendar.json')) };
}
