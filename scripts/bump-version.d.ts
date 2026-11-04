export interface CurrentVersions {
  packageJson: string;
  tauriConf: string;
  cargoToml: string | null;
}

export interface VersionConsistencyResult {
  consistent: boolean;
  versions: CurrentVersions;
  version: string | null;
}

export function readCurrentVersions(): CurrentVersions;
export function checkVersionConsistency(): VersionConsistencyResult;
export function bumpVersion(targetVersion: string): string;
