#!/usr/bin/env node
/**
 * @file bump-version.js
 * Synchronize and validate version string across:
 * - package.json & package-lock.json
 * - Cargo.toml ([workspace.package] version)
 * - src-tauri/tauri.conf.json (version)
 *
 * Usage:
 *   node scripts/bump-version.js <new-version>
 *   node scripts/bump-version.js --check
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const packageJsonPath = path.join(rootDir, 'package.json');
const packageLockJsonPath = path.join(rootDir, 'package-lock.json');
const cargoTomlPath = path.join(rootDir, 'Cargo.toml');
const tauriConfJsonPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');

const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function readCurrentVersions() {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfJsonPath, 'utf8'));
  const cargoContent = fs.readFileSync(cargoTomlPath, 'utf8');

  const cargoMatch = cargoContent.match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/);
  const cargoVersion = cargoMatch ? cargoMatch[1] : null;

  return {
    packageJson: pkg.version,
    tauriConf: tauriConf.version,
    cargoToml: cargoVersion,
  };
}

export function checkVersionConsistency() {
  const versions = readCurrentVersions();
  const values = Object.values(versions);
  const allMatch = values.every((v) => v && v === values[0]);

  return {
    consistent: allMatch,
    versions,
    version: allMatch ? values[0] : null,
  };
}

export function bumpVersion(targetVersion) {
  const cleanVersion = targetVersion.replace(/^v/i, '').trim();
  if (!SEMVER_REGEX.test(cleanVersion)) {
    throw new Error(`Invalid semver version: "${targetVersion}". Expected format like 0.1.1 or 0.1.1-rc.1`);
  }

  // 1. package.json
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  pkg.version = cleanVersion;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  // 2. package-lock.json (if present)
  if (fs.existsSync(packageLockJsonPath)) {
    const lock = JSON.parse(fs.readFileSync(packageLockJsonPath, 'utf8'));
    lock.version = cleanVersion;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = cleanVersion;
    }
    fs.writeFileSync(packageLockJsonPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  }

  // 3. Cargo.toml
  let cargoContent = fs.readFileSync(cargoTomlPath, 'utf8');
  const cargoRegex = /(\[workspace\.package\][\s\S]*?version\s*=\s*)"[^"]+"/;
  if (!cargoRegex.test(cargoContent)) {
    throw new Error('Could not find [workspace.package] version in Cargo.toml');
  }
  cargoContent = cargoContent.replace(cargoRegex, `$1"${cleanVersion}"`);
  fs.writeFileSync(cargoTomlPath, cargoContent, 'utf8');

  // 4. src-tauri/tauri.conf.json
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfJsonPath, 'utf8'));
  tauriConf.version = cleanVersion;
  fs.writeFileSync(tauriConfJsonPath, `${JSON.stringify(tauriConf, null, 2)}\n`, 'utf8');

  const check = checkVersionConsistency();
  if (!check.consistent) {
    throw new Error(`Inconsistency detected after bump: ${JSON.stringify(check.versions)}`);
  }

  return cleanVersion;
}

// CLI runner
if (process.argv[1] === __filename) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage:');
    console.log('  node scripts/bump-version.js <new-version>    # e.g. 0.1.1');
    console.log('  node scripts/bump-version.js --check          # Validate consistency');
    process.exit(0);
  }

  if (args[0] === '--check') {
    const check = checkVersionConsistency();
    if (check.consistent) {
      console.log(`[Version Check] OK: All files consistent at v${check.version}`);
      console.log(`  - package.json:          ${check.versions.packageJson}`);
      console.log(`  - Cargo.toml (workspace): ${check.versions.cargoToml}`);
      console.log(`  - src-tauri/tauri.conf:   ${check.versions.tauriConf}`);
      process.exit(0);
    } else {
      console.error('[Version Check] MISMATCH detected between version files:');
      console.error(`  - package.json:          ${check.versions.packageJson}`);
      console.error(`  - Cargo.toml (workspace): ${check.versions.cargoToml}`);
      console.error(`  - src-tauri/tauri.conf:   ${check.versions.tauriConf}`);
      process.exit(1);
    }
  }

  try {
    const updated = bumpVersion(args[0]);
    console.log(`[Version Bump] Successfully bumped version to ${updated}`);
    console.log(`  ✓ Updated package.json`);
    console.log(`  ✓ Updated package-lock.json`);
    console.log(`  ✓ Updated Cargo.toml [workspace.package]`);
    console.log(`  ✓ Updated src-tauri/tauri.conf.json`);
  } catch (err) {
    console.error(`[Version Bump] Error: ${err.message}`);
    process.exit(1);
  }
}
