// Isolation checks against the *live* Desktop installation: adding this plugin
// must not collide with anything already loaded there.
//
// Scanned evidence:
//   - every other external plugin installed in the Desktop profile
//     (module-graph id, slot entry id, locale namespace, localStorage keys,
//     loader row id);
//   - the profile's own patch layer and each bundle's patch;
//   - the shipped Desktop app.asar (built-in client bundles), to prove the
//     isolated identifiers are ours alone and that `sidebar.footer.action` is a
//     list slot — a slot that accepts several entries, so registering a new
//     footer action alongside existing ones cannot displace them.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const DSH_HOME = process.env.DSH_HOME ?? 'D:/DeepseekHome'
const DESKTOP_PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const ASAR_PATH = process.env.DSH_ASAR ?? 'D:/DeepSeek Harness/resources/app.asar'

const OWN = {
  packageName: '@dsh-external/dsh-task-notifier-desktop',
  rowId: 'task-notifier-desktop',
  namespace: 'taskNotifierDesktop',
  slotId: 'task-notifier-toggle-desktop',
  settingsKey: 'dsh-task-notifier-desktop:settings',
  dedupPrefix: 'dsh-task-notifier-desktop:last',
  /** As emitted by tsdown, on the loader banner line. */
  bannerId: 'id: "@dsh-external/dsh-task-notifier-desktop"',
}
const OWN_BUNDLE = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')

/** One level of installed external packages under the Desktop profile. */
function installedPackages() {
  const found = []
  for (const scope of ['@dsh-external']) {
    const scopeDir = join(DESKTOP_PROFILE, 'node_modules', scope)
    let names
    try {
      names = readdirSync(scopeDir)
    } catch {
      continue
    }
    for (const name of names) {
      const dir = join(scopeDir, name)
      if (dir === join(DESKTOP_PROFILE, 'node_modules', scope, OWN.packageName.split('/')[1])) continue
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue
      found.push({ dir, id: `${scope}/${name}` })
    }
  }
  const bare = join(DESKTOP_PROFILE, 'node_modules', 'trisoul_x')
  if (statSync(bare, { throwIfNoEntry: false })?.isDirectory()) found.push({ dir: bare, id: 'trisoul_x' })
  return found
}

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function walkFiles(root, maxDepth, depth = 0, out = []) {
  if (depth > maxDepth) return out
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) walkFiles(path, maxDepth, depth + 1, out)
    else if (entry.isFile()) out.push(path)
  }
  return out
}

// ------------------------------------------------- installed-plugin scan ----

test('no other installed Desktop plugin claims this plugin\'s identifiers', () => {
  const packages = installedPackages()
  assert.ok(packages.length > 0, 'expected at least one other external plugin in the Desktop profile')

  const collisions = []
  for (const { dir, id } of packages) {
    const texts = [
      ['lib/client.js', readIfPresent(join(dir, 'lib', 'client.js'))],
      ['lib/index.js', readIfPresent(join(dir, 'lib', 'index.js'))],
      ['package.json', readIfPresent(join(dir, 'package.json'))],
      ['cordis.patch.yml', readIfPresent(join(dir, 'cordis.patch.yml'))],
    ].filter(([, text]) => typeof text === 'string')
    for (const [file, text] of texts) {
      for (const needle of [OWN.packageName, OWN.namespace, OWN.slotId, OWN.settingsKey, OWN.dedupPrefix, OWN.bannerId]) {
        if (text.includes(needle)) collisions.push(`${id}/${file} ← ${needle}`)
      }
      if (file === 'cordis.patch.yml' || file === 'lib/index.js') {
        // Row ids only collide when declared as a loader row.
        if (new RegExp(`id:\\s*${OWN.rowId}\\b`).test(text)) collisions.push(`${id}/${file} ← loader row ${OWN.rowId}`)
      }
    }
  }
  assert.deepEqual(collisions, [], `identifier collisions with existing Desktop plugins:\n${collisions.join('\n')}`)
})

test('no other Desktop module-graph row registers the same client bundle id', () => {
  const packages = installedPackages()
  const bannerIds = new Map()
  for (const { dir, id } of packages) {
    const client = readIfPresent(join(dir, 'lib', 'client.js'))
    if (client === undefined) continue
    const match = /window\.__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(client)
    if (match !== null) {
      const list = bannerIds.get(match[1]) ?? []
      list.push(id)
      bannerIds.set(match[1], list)
    }
  }
  const ownId = /window\.__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(OWN_BUNDLE)?.[1]
  assert.equal(ownId, OWN.packageName, 'own bundle declares the isolated package id')
  assert.equal(bannerIds.get(ownId), undefined, `client bundle id ${ownId} is already registered by ${bannerIds.get(ownId)}`)
})

test('the Desktop profile\'s patch layer does not declare the isolated loader row', () => {
  const profilePatch = readIfPresent(join(DESKTOP_PROFILE, 'cordis.patch.yml')) ?? ''
  const ownPackagePatch = readIfPresent(join(import.meta.dirname, '..', 'cordis.patch.yml')) ?? ''
  assert.ok(ownPackagePatch.includes(OWN.rowId), 'own bundle patch declares the isolated row')
  const otherDeclarations = profilePatch
    .split('\n')
    .filter(line => new RegExp(`^\\s*-\\s*id:\\s*${OWN.rowId}\\b`).test(line))
  // The profile may *target* the row (config override) but must not insert a
  // second definition of it; the bundle patch owns the definition.
  assert.deepEqual(
    otherDeclarations.filter(line => line.includes('insert')),
    [],
    'the profile patch must not insert a duplicate of the bundle-owned row',
  )
})

// ------------------------------------------------------- shipped app.asar ---

/** Read entry text out of an uncompressed asar by header offset. */
function asarReader(asarPath) {
  const fd = readFileSync(asarPath, { flag: 'r' })
  const headerSize = fd.readUInt32LE(4)
  const jsonLength = fd.readUInt32LE(12)
  const header = JSON.parse(fd.subarray(16, 16 + jsonLength).toString('utf8'))
  const dataOffset = 8 + headerSize
  const entries = []
  ;(function walk(node, rel) {
    if (node.files === undefined) {
      const offset = node.offset === undefined ? Number.NaN : Number(node.offset)
      if (Number.isInteger(offset)) entries.push({ rel, size: Number(node.size), offset })
      return
    }
    for (const [name, child] of Object.entries(node.files)) walk(child, rel === '' ? name : `${rel}/${name}`)
  })(header, '')
  return {
    entries,
    read(entry) { return fd.subarray(dataOffset + entry.offset, dataOffset + entry.offset + entry.size).toString('utf8') },
  }
}

test('the shipped Desktop app contains none of the isolated identifiers', () => {
  const asar = statSync(ASAR_PATH, { throwIfNoEntry: false })
  if (asar === undefined || !asar.isFile()) {
    assert.fail(`Desktop app.asar not found at ${ASAR_PATH} (set DSH_ASAR to override)`)
  }
  const reader = asarReader(ASAR_PATH)
  const interesting = reader.entries.filter(entry => entry.rel.startsWith('dsh/') && entry.size > 0 && entry.size < 8 * 1024 * 1024)
  const hits = []
  // The package name and loader row id are included so a built-in bundle that
  // happened to claim either would be caught too, not just the runtime ids.
  for (const entry of interesting) {
    const text = reader.read(entry)
    for (const needle of [OWN.packageName, OWN.rowId, OWN.namespace, OWN.slotId, OWN.settingsKey, OWN.dedupPrefix]) {
      if (text.includes(needle)) hits.push(`${entry.rel} ← ${needle}`)
    }
  }
  assert.deepEqual(hits, [], `shipped app already contains isolated identifiers:\n${hits.join('\n')}`)
})

test('sidebar.footer.action is a list slot, so a new footer action cannot displace existing ones', () => {
  const reader = asarReader(ASAR_PATH)
  const contractEntry = reader.entries.find(entry => entry.rel.endsWith('dsh-cordis-client-runner/lib/client.js'))
  assert.ok(contractEntry !== undefined, 'slot contract bundle is present')
  const contract = reader.read(contractEntry)
  // Match the declaration entry itself, not merely a substring 160 chars after
  // the first mention: `{ key: "sidebar.footer.action", kind: "list", … }`.
  const declaration = /key:\s*"sidebar\.footer\.action"\s*,\s*kind:\s*"list"/.exec(contract)
  assert.ok(
    declaration !== null,
    `the shipped slot contract must declare sidebar.footer.action as kind "list"; entry not found in ${contractEntry.rel}`,
  )
  // The own registration targets exactly that declared slot.
  assert.ok(OWN_BUNDLE.includes('sidebar.footer.action'), 'own bundle registers into the declared slot')
})

test('the Web twin is a separate package and stays out of the Desktop profile', () => {
  const desktopProfile = JSON.parse(readFileSync(join(DESKTOP_PROFILE, 'package.json'), 'utf8'))
  const bundles = desktopProfile.dsh?.profile?.bundles ?? []
  assert.ok(!bundles.includes('@dsh-external/dsh-task-notifier'), 'Desktop profile must not load the Web twin')
  assert.ok(!Object.hasOwn(desktopProfile.dependencies ?? {}, '@dsh-external/dsh-task-notifier'))
  // Conversely the Desktop twin's identifiers never leak into the Web bundle.
  // The Web source was removed on 2026-10-17; skip this control when absent.
  const webBundlePath = 'D:/collection_of_projects/dsh/dsh-task-notifier/lib/client.js'
  if (existsSync(webBundlePath)) {
    const webBundle = readFileSync(webBundlePath, 'utf8')
    for (const needle of [OWN.namespace, OWN.slotId, OWN.settingsKey, OWN.dedupPrefix]) {
      assert.ok(!webBundle.includes(needle), `Web twin bundle must not contain ${needle}`)
    }
  }
})