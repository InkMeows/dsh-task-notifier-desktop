// Offline verification of everything that decides whether the Desktop twin is
// actually installable and isolated — no GUI required.
//
//  1. Peer-compatibility gate. dsh 0.2.x's dsh-app-boot adds
//     `evaluatePluginCompatibility()` (verified by hand in
//     .recon/asar/dsh-app-boot/lib/index.js:286-313): it walks every
//     `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer and requires
//     semver.satisfies(runtimeVersion, range, { includePrerelease: true }).
//     A failing bundle is skipped wholesale and its loader row disabled. This
//     script re-applies exactly that rule with semver 7.x, the same major line
//     the Desktop app bundles, and controls the Web twin (which MUST be rejected).
//  2. Bundle identity. The `window.__ModuleLoader__.load` banner id must equal
//     the isolated package name, because dsh-client-modules keys the module
//     graph by package name.
//  3. Host half. Import the built lib/index.js and apply() it with a stub
//     context; it must be a no-op row declaring the isolated name.
//  4. Loader row. cordis.patch.yml must insert the isolated row id + package.
//  5. Profile wiring. The Desktop profile names the -desktop package; the Web
//     profile must not, and vice versa (deployment-level version isolation).
//  6. Client identifiers. Every isolated identifier is present and the Web
//     twin's counterparts are absent.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openAsar } from './lib/asar.mjs'

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_HOME = process.env.DSH_HOME ?? 'D:/DeepseekHome'
const DESKTOP_PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const WEB_PROFILE = join(DSH_HOME, 'profiles', 'web')
const WEB_TWIN = 'D:/collection_of_projects/dsh/dsh-task-notifier'
const ASAR_PATH = process.env.DSH_ASAR ?? 'D:/DeepSeek Harness/resources/app.asar'
/**
 * The version the gate compares against. `getDshRuntimeVersion()` reads the
 * installed `@deepseek-ai/dsh-app-boot` manifest, so read the same thing rather
 * than hardcoding — otherwise this check would keep measuring an old release
 * after an app update.
 */
function installedRuntimeVersion() {
  try {
    const asar = openAsar(ASAR_PATH)
    const entry = asar.at('dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json')
    if (entry !== undefined) {
      const version = JSON.parse(asar.read(entry)).version
      if (typeof version === 'string' && version.length > 0) {
        return { version, source: 'app.asar → @deepseek-ai/dsh-app-boot/package.json' }
      }
    }
  } catch {
    // fall through to the packaged runtime manifest
  }
  try {
    const manifest = JSON.parse(readFileSync(
      join(dirname(ASAR_PATH), 'runtime', 'primary-runtime', 'runtime.json'), 'utf8',
    ))
    if (typeof manifest.desktopVersion === 'string') {
      return { version: manifest.desktopVersion, source: 'resources/runtime/primary-runtime/runtime.json' }
    }
  } catch {
    // fall through
  }
  return { version: '0.2.1-rc.2', source: 'built-in fallback constant' }
}

const { version: runtimeVersion, source: runtimeVersionSource } = installedRuntimeVersion()
/** Resolution base for this plugin's own test-time dependencies. */
const selfRequire = createRequire(join(APP_ROOT, 'package.json'))

const results = []
const ok = (label, extra = '') => results.push(['PASS', label, extra])
const bad = (label, extra = '') => results.push(['FAIL', label, extra])
const json = path => JSON.parse(readFileSync(path, 'utf8'))

/** Faithful copy of the gate's peer loop (dsh-app-boot/lib/index.js:296-306). */
function incompatiblePeers(manifest, semver) {
  const fields = manifest
  if (!Object.hasOwn(fields, 'peerDependencies')) return undefined
  const peers = {}
  for (const [name, range] of Object.entries(fields.peerDependencies)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range
    if (requirement.trim() === '' || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) {
      peers[name] = range
    }
  }
  return Object.keys(peers).length === 0 ? undefined : peers
}

// ------------------------------------------------------- 1. peer gate --------
const desktopManifest = json(join(APP_ROOT, 'package.json'))
let semver
try {
  semver = selfRequire('semver')
} catch (error) {
  bad('resolve the Desktop app\'s own semver', String(error?.message ?? error))
}
if (semver !== undefined) {
  const peers = incompatiblePeers(desktopManifest, semver)
  const checked = Object.keys(desktopManifest.peerDependencies)
    .filter(n => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'))
  const context = `dsh ${runtimeVersion} (${runtimeVersionSource}); ${checked.length} dsh-* peers: ${checked.join(', ')}`
  if (peers === undefined) {
    ok(`peer gate accepts the Desktop twin`, context)
  } else {
    bad('peer gate accepts the Desktop twin', `${context}; incompatible: ${JSON.stringify(peers)}`)
  }

  // Control: the Web twin must be REJECTED — that is exactly why a single
  // shared copy cannot serve both profiles. The source is optional: the Web
  // runtime was removed on 2026-10-17, so this check degrades to a skip.
  const webTwinManifest = join(WEB_TWIN, 'package.json')
  if (existsSync(webTwinManifest)) {
    const webPeers = incompatiblePeers(json(webTwinManifest), semver)
    if (webPeers !== undefined) {
      ok('control: Web twin rejected by the same gate', Object.entries(webPeers).map(([n, r]) => `${n}@${r}`).join(', '))
    } else {
      bad('control: Web twin should be rejected by the 0.2.1 gate')
    }
  } else {
    ok('control: Web twin source removed; peer negative control skipped')
  }
}

// -------------------------------------------------- 2. bundle identity ------
const clientJs = readFileSync(join(APP_ROOT, 'lib', 'client.js'), 'utf8')
const banner = /window\.__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(clientJs)
if (banner?.[1] === desktopManifest.name) {
  ok('client bundle banner id equals the isolated package name', banner[1])
} else {
  bad('client bundle banner id equals the isolated package name', `banner=${banner?.[1]}`)
}
// Enumerate the bundle's own `require(...)` calls: everything it pulls from the
// shared module graph must be a host-provided external (react today). Unlike a
// bare substring check this also fails on an empty/gutted bundle.
const requires = [...new Set([...clientJs.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]))]
const ALLOWED_EXTERNALS = new Set(['react', 'react/jsx-runtime'])
const unexpectedExternals = requires.filter(name => !ALLOWED_EXTERNALS.has(name))
if (requires.length > 0 && unexpectedExternals.length === 0) {
  ok('client bundle requires only host-provided externals', requires.join(', '))
} else {
  bad('client bundle requires only host-provided externals',
    `requires=[${requires.join(', ')}] unexpected=[${unexpectedExternals.join(', ')}]`)
}

// ------------------------------------------------------- 3. host half --------
let plugin
try {
  plugin = await import(`file:///${join(APP_ROOT, 'lib', 'index.js').replaceAll('\\', '/')}`)
} catch (error) {
  bad('host half imports', String(error?.message ?? error))
}
if (plugin !== undefined) {
  const stubCtx = { logger: () => ({ warn() {}, info() {}, error() {} }), get: () => undefined }
  try {
    plugin.apply(stubCtx, {})
    if (plugin.name === desktopManifest.name && Array.isArray(plugin.inject) && plugin.inject.length === 0) {
      ok('host half applies as a no-op row', `name=${plugin.name} inject=[]`)
    } else {
      bad('host half applies as a no-op row', `name=${plugin.name} inject=${JSON.stringify(plugin.inject)}`)
    }
  } catch (error) {
    bad('host half applies as a no-op row', String(error?.message ?? error))
  }
}

// ------------------------------------------------------ 4. loader row --------
const patchPath = join(APP_ROOT, 'cordis.patch.yml')
const patch = readFileSync(patchPath, 'utf8')
const rowId = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(patch)?.[1]
const rowName = /^\s*name:\s*'([^']+)'\s*$/m.exec(patch)?.[1]
if (rowId === 'task-notifier-desktop' && rowName === desktopManifest.name) {
  ok('bundle patch inserts the isolated loader row', `${rowId} → ${rowName}`)
} else {
  bad('bundle patch inserts the isolated loader row', `id=${rowId} name=${rowName}`)
}
// The loader parses this file for real; parse it the same way so a change that
// only breaks YAML (not the regex) still fails here.
try {
  const { parse } = selfRequire('yaml')
  const document = parse(patch)
  const inserted = Array.isArray(document)
    ? document.flatMap(entry => entry?.insert ?? []).filter(entry => entry?.id === 'task-notifier-desktop')
    : []
  if (inserted.length === 1 && inserted[0].name === desktopManifest.name) {
    ok('bundle patch parses as one insert row', JSON.stringify(inserted[0]))
  } else {
    bad('bundle patch parses as one insert row', JSON.stringify(document))
  }
} catch (error) {
  bad('bundle patch parses as YAML', String(error?.message ?? error))
}

// The loader also requires every profile bundle to declare `dsh.bundle`.
if (desktopManifest.dsh?.bundle?.patch === './cordis.patch.yml') {
  ok('bundle manifest declares dsh.bundle.patch')
} else {
  bad('bundle manifest declares dsh.bundle.patch', JSON.stringify(desktopManifest.dsh))
}
// dsh-client-modules resolves the client half from these two fields.
if (desktopManifest.dsh?.client?.platform === 'web'
  && desktopManifest.exports?.['./client']?.default === './lib/client.js') {
  ok('client half is discoverable (platform web + exports["./client"])')
} else {
  bad('client half is discoverable (platform web + exports["./client"])', JSON.stringify(desktopManifest.dsh?.client))
}
// The factory must open as `load({id, factory: (require) => {` and close with the
// module-export footer (a trailing sourcemap comment is fine). This is the
// protocol `dsh-client-modules` reads the bundle with.
const clientTail = clientJs.replace(/\/\/# sourceMappingURL=.*$/m, '').trimEnd()
const factoryOpen = /window\.__ModuleLoader__\.load\(\s*\{\s*id:\s*"[^"]+",\s*factory:\s*\(require\)\s*=>\s*\{/.test(clientJs)
const factoryClose = /return module\.exports;\s*\}\s*\}\);$/.test(clientTail)
if (factoryOpen && factoryClose) {
  ok('client bundle uses the lazy CJS factory protocol')
} else {
  bad('client bundle uses the lazy CJS factory protocol', `open=${factoryOpen} close=${factoryClose} tail=${JSON.stringify(clientTail.slice(-40))}`)
}

// --------------------------------------------------- 5. profile wiring -------
const desktopProfile = json(join(DESKTOP_PROFILE, 'package.json'))
const webProfilePath = join(WEB_PROFILE, 'package.json')
const webProfileExists = existsSync(webProfilePath)
const webProfile = webProfileExists ? json(webProfilePath) : undefined
const desktopBundles = desktopProfile.dsh?.profile?.bundles ?? []
if (desktopBundles.includes(desktopManifest.name)) {
  ok('Desktop profile lists the Desktop twin as a bundle')
} else {
  bad('Desktop profile lists the Desktop twin as a bundle', desktopBundles.join(', '))
}
const dependency = desktopProfile.dependencies?.[desktopManifest.name]
if (typeof dependency === 'string' && dependency.startsWith('link:')) {
  ok('Desktop profile links the source workspace', dependency)
} else {
  bad('Desktop profile links the source workspace', String(dependency))
}
const webBundles = webProfile?.dsh?.profile?.bundles ?? []
if (!webProfileExists) {
  ok('Web profile removed; web-side isolation check not applicable')
} else if (!webBundles.includes(desktopManifest.name) && !Object.hasOwn(webProfile.dependencies ?? {}, desktopManifest.name)) {
  ok('Web profile never names the Desktop twin')
} else {
  bad('Web profile never names the Desktop twin')
}
if (!desktopBundles.includes('@dsh-external/dsh-task-notifier')
  && !Object.hasOwn(desktopProfile.dependencies ?? {}, '@dsh-external/dsh-task-notifier')) {
  ok('Desktop profile never names the Web twin')
} else {
  bad('Desktop profile never names the Web twin')
}
if (!webProfileExists) {
  ok('Web profile removed; skip Web twin loading check')
} else if (webBundles.includes('@dsh-external/dsh-task-notifier')) {
  ok('Web profile still loads the Web twin (unchanged)')
} else {
  bad('Web profile still loads the Web twin (unchanged)', webBundles.join(', '))
}

// ------------------------------------------------ 6. identifier isolation ----
const WEB_IDENTIFIERS = [
  ['selector', /@dsh-external\/dsh-task-notifier(?!-desktop)/],
  ['locale namespace', /["']taskNotifier["']/],
  ['slot entry id', /["']task-notifier-toggle["']/],
  ['settings key', /dsh-task-notifier:settings/],
  ['dedup prefix', /dsh-task-notifier:last/],
]
const DESKTOP_IDENTIFIERS = [
  ['selector', /@dsh-external\/dsh-task-notifier-desktop/],
  ['locale namespace', /["']taskNotifierDesktop["']/],
  ['slot entry id', /["']task-notifier-toggle-desktop["']/],
  ['settings key', /dsh-task-notifier-desktop:settings/],
  ['dedup prefix', /dsh-task-notifier-desktop:last/],
]
for (const [label, pattern] of DESKTOP_IDENTIFIERS) {
  if (pattern.test(clientJs)) ok(`Desktop bundle carries its own ${label}`)
  else bad(`Desktop bundle carries its own ${label}`)
}
for (const [label, pattern] of WEB_IDENTIFIERS) {
  if (!pattern.test(clientJs)) ok(`Desktop bundle has no Web ${label}`)
  else bad(`Desktop bundle has no Web ${label}`)
}
const webTwinBundle = join(WEB_TWIN, 'lib', 'client.js')
if (!existsSync(webTwinBundle)) {
  ok('Web twin source removed; identifier negative controls skipped')
} else {
  const webClientJs = readFileSync(webTwinBundle, 'utf8')
  for (const [label, pattern] of DESKTOP_IDENTIFIERS) {
    if (!pattern.test(webClientJs)) ok(`Web bundle has no Desktop ${label}`)
    else bad(`Web bundle has no Desktop ${label}`)
  }
}

// ------------------------------------------- 7. composed loader rows -------
// The loader builds the tree as: every bundle's own `dsh.bundle.patch` layer (in
// `dsh.profile.bundles` order), then the profile patch. Each `insert:` appends
// rows. Model exactly that and check the composition is coherent.
let parseYaml
try {
  parseYaml = text => selfRequire('yaml').parse(text, { logLevel: 'silent' })
} catch {
  parseYaml = undefined
}
if (parseYaml === undefined) {
  bad('compose the Desktop profile loader rows', 'the profile\'s yaml parser is unavailable')
} else {
  const asar = (() => {
    try {
      return openAsar(ASAR_PATH)
    } catch {
      return undefined
    }
  })()

  /** Every bundle-patch layer the loader would read for one profile bundle. */
  function bundlePatchTexts(name) {
    const localDir = join(DESKTOP_PROFILE, 'node_modules', ...name.split('/'))
    const localManifest = join(localDir, 'package.json')
    const layersOf = decl => typeof decl === 'string' ? [decl] : Array.isArray(decl) ? decl : []
    if (existsSync(localManifest)) {
      return layersOf(json(localManifest).dsh?.bundle?.patch)
        .map(rel => [rel, existsSync(join(localDir, rel)) ? readFileSync(join(localDir, rel), 'utf8') : undefined])
    }
    if (asar === undefined) return [[undefined, undefined]]
    const manifestEntry = asar.at(`dsh/node_modules/${name}/package.json`)
    if (manifestEntry === undefined) return [[undefined, undefined]]
    const decl = JSON.parse(asar.read(manifestEntry)).dsh?.bundle?.patch
    return layersOf(decl).map(rel => {
      const entry = asar.at(`dsh/node_modules/${name}/${rel.replace(/^\.\//, '')}`)
      return [rel, entry === undefined ? undefined : asar.read(entry)]
    })
  }

  const rowIds = new Map()
  const unresolved = []
  for (const name of desktopBundles) {
    const layers = bundlePatchTexts(name)
    if (layers.length === 0 || layers.every(([, text]) => text === undefined)) {
      unresolved.push(name)
      continue
    }
    for (const [rel, text] of layers) {
      if (text === undefined) {
        unresolved.push(`${name} ← ${rel}`)
        continue
      }
      for (const entry of parseYaml(text) ?? []) {
        for (const row of entry?.insert ?? []) {
          if (typeof row?.id !== 'string') continue
          const holders = rowIds.get(row.id) ?? []
          holders.push(name)
          rowIds.set(row.id, holders)
        }
      }
    }
  }
  const duplicates = [...rowIds].filter(([, holders]) => holders.length > 1)
  if (duplicates.length === 0) {
    ok('no loader row id is inserted twice', `${rowIds.size} inserted rows across ${desktopBundles.length} bundles`)
  } else {
    bad('no loader row id is inserted twice', duplicates.map(([id, h]) => `${id} ← ${h.join(', ')}`).join(' | '))
  }
  const ours = rowIds.get('task-notifier-desktop')
  if (ours?.length === 1 && ours[0] === desktopManifest.name) {
    ok('the composed tree inserts the isolated row exactly once', `task-notifier-desktop ← ${ours[0]}`)
  } else {
    bad('the composed tree inserts the isolated row exactly once', JSON.stringify(ours))
  }
  if (unresolved.length === 0) {
    ok('every profile bundle patch is resolvable')
  } else {
    bad('every profile bundle patch is resolvable', `unresolved: ${unresolved.join(', ')}`)
  }
}

// ---------------------------------------------------------------- report ----
for (const [state, label, extra] of results) console.log(`${state}  ${label}${extra ? '  -- ' + extra : ''}`)
const failures = results.filter(r => r[0] === 'FAIL').length
console.log(`\n${results.length - failures}/${results.length} checks passed`)
process.exitCode = failures === 0 ? 0 : 1