import { describe, it, expect } from 'vitest';
import { readCurrentVersions, checkVersionConsistency } from '../../scripts/bump-version.js';

describe('Version Consistency & Bump Script', () => {
  it('reads current versions across package.json, Cargo.toml and tauri.conf.json', () => {
    const versions = readCurrentVersions();
    expect(versions.packageJson).toBe('0.1.0');
    expect(versions.cargoToml).toBe('0.1.0');
    expect(versions.tauriConf).toBe('0.1.0');
  });

  it('validates that all version files are currently in complete sync', () => {
    const check = checkVersionConsistency();
    expect(check.consistent).toBe(true);
    expect(check.version).toBe('0.1.0');
  });
});
