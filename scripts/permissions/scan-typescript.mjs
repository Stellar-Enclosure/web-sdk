import { readFile, realpath } from 'node:fs/promises'
import { resolve, dirname, relative, isAbsolute } from 'node:path'
import ts from 'typescript'
import { canonicalJson, sha256 } from './canonicalize.mjs'

const MARKERS = new Map([
  ['definePermissions', 'permissionDefinitions'], ['definePermissionReferences', 'permissionReferences'],
  ['defineResources', 'resources'], ['defineResourceReferences', 'resourceReferences'], ['defineMessages', 'messages'],
])
const MARKER_MODULES = new Set(['@stellar-enclosure/stellar-enclosure-web-shared', '@stellar-enclosure/stellar-enclosure-web-shared/permissions'])
const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,199}$/.test(value)
const within = (root, path) => { const name = relative(root, path); return name !== '..' && !name.startsWith('../') && !isAbsolute(name) }
const unwrap = node => {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression
  return node
}
const fail = (node, reason) => {
  const source = node.getSourceFile()
  const position = source.getLineAndCharacterOfPosition(node.getStart(source))
  throw new Error(`${reason}:${source.fileName}:${position.line + 1}:${position.character + 1}`)
}

/** Only dedicated const declaration modules are parsed. No application module is imported or evaluated. */
export const scanTypescript = async (config, { root, validate }) => {
  root = await realpath(root)
  if (!config || config.schemaVersion !== 1 || !Array.isArray(config.expectedModules) || !config.expectedModules.length
    || config.expectedModules.length > 256 || config.expectedModules.some(value => !identifier(value))
    || new Set(config.expectedModules.map(value => value.toLowerCase())).size !== config.expectedModules.length
    || !config.modules || typeof config.modules !== 'object' || Array.isArray(config.modules)
    || !['FULL', 'PARTIAL'].includes(config.snapshotMode ?? 'FULL')) throw new Error('SCAN_CONFIG_INVALID')
  const allowedKeys = new Set(['schemaVersion', 'application', 'producerId', 'ownedKeyPrefixes', 'expectedModules', 'modules', 'artifact', 'snapshotMode', 'clearIntent', 'tsconfig', 'toolchainLock'])
  if (Object.keys(config).some(key => !allowedKeys.has(key))) throw new Error('SCAN_CONFIG_UNKNOWN_PROPERTY')
  const moduleIds = Object.keys(config.modules).sort()
  const mode = config.snapshotMode ?? 'FULL'
  if (!moduleIds.length || moduleIds.some(value => !config.expectedModules.includes(value))
    || (mode === 'FULL' && canonicalJson(moduleIds) !== canonicalJson([...config.expectedModules].sort()))) throw new Error('SCAN_EXPECTED_MODULE_MISSING')
  let compilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext }
  if (config.tsconfig) {
    const tsconfig = await realpath(resolve(root, config.tsconfig))
    if (!within(root, tsconfig)) throw new Error('SCAN_TSCONFIG_OUTSIDE_ROOT')
    const loaded = ts.readConfigFile(tsconfig, ts.sys.readFile)
    if (loaded.error) throw new Error('SCAN_TSCONFIG_INVALID')
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(tsconfig))
    if (parsed.errors.some(value => value.category === ts.DiagnosticCategory.Error)) throw new Error('SCAN_TSCONFIG_INVALID')
    compilerOptions = { ...parsed.options, noEmit: true }
  }
  const files = new Map()
  const loading = new Set()
  let totalBytes = 0
  const load = async path => {
    path = await realpath(path)
    if (!within(root, path) || !/\.tsx?$/.test(path) || path.endsWith('.d.ts')) throw new Error('SCAN_IMPORT_OUTSIDE_SOURCE_ROOT')
    if (loading.has(path)) throw new Error('SCAN_CYCLIC_MODULE_IMPORT')
    if (files.has(path)) return files.get(path)
    if (files.size >= 2048) throw new Error('SCAN_MODULE_LIMIT')
    loading.add(path)
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))
    totalBytes += Buffer.byteLength(content)
    if (Buffer.byteLength(content) > 2 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) throw new Error('SCAN_SOURCE_BYTE_LIMIT')
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    if (source.parseDiagnostics.length) throw new Error('SCAN_TYPESCRIPT_SYNTAX_INVALID:' + relative(root, path))
    const file = { source, locals: new Map(), imports: new Map(), exported: new Map(), digest: sha256(content) }
    const add = (name, value) => {
      if (file.locals.has(name) || file.imports.has(name)) fail(value, 'SCAN_DUPLICATE_SYMBOL')
      file.locals.set(name, value)
    }
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (!ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) fail(statement, 'SCAN_SIDE_EFFECT_IMPORT_FORBIDDEN')
        if (statement.importClause.isTypeOnly) {
          if (!MARKER_MODULES.has(statement.moduleSpecifier.text)
            && !ts.resolveModuleName(statement.moduleSpecifier.text, path, compilerOptions, ts.sys).resolvedModule) fail(statement, 'SCAN_IMPORT_UNRESOLVED')
          continue
        }
        if (statement.importClause.name || !statement.importClause.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) fail(statement, 'SCAN_NAMED_IMPORT_REQUIRED')
        const specifier = statement.moduleSpecifier.text
        const names = statement.importClause.namedBindings.elements.filter(value => !value.isTypeOnly)
        if (MARKER_MODULES.has(specifier)) {
          for (const name of names) {
            const imported = (name.propertyName ?? name.name).text
            if (!MARKERS.has(imported) || file.imports.has(name.name.text) || file.locals.has(name.name.text)) fail(name, 'SCAN_MARKER_IMPORT_INVALID')
            file.imports.set(name.name.text, { marker: imported })
          }
        } else {
          const result = ts.resolveModuleName(specifier, path, compilerOptions, ts.sys).resolvedModule
          if (!result) fail(statement, 'SCAN_IMPORT_UNRESOLVED')
          const dependency = await load(result.resolvedFileName)
          for (const name of names) {
            if (file.imports.has(name.name.text) || file.locals.has(name.name.text)) fail(name, 'SCAN_DUPLICATE_SYMBOL')
            const imported = (name.propertyName ?? name.name).text
            if (!dependency.exported.has(imported)) fail(name, 'SCAN_IMPORT_EXPORT_MISSING')
            file.imports.set(name.name.text, { file: dependency, name: imported })
          }
        }
      } else if (ts.isVariableStatement(statement)) {
        if (!(statement.declarationList.flags & ts.NodeFlags.Const)) fail(statement, 'SCAN_CONST_REQUIRED')
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) fail(declaration, 'SCAN_SIMPLE_INITIALIZED_CONST_REQUIRED')
          add(declaration.name.text, declaration.initializer)
          if (statement.modifiers?.some(value => value.kind === ts.SyntaxKind.ExportKeyword)) file.exported.set(declaration.name.text, declaration.initializer)
        }
      } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement)) {
        continue
      } else fail(statement, 'SCAN_UNSUPPORTED_TOP_LEVEL_SYNTAX')
    }
    loading.delete(path)
    files.set(path, file)
    return file
  }
  const active = new Set()
  const cache = new Map()
  const reference = (file, name, node, depth) => {
    const imported = file.imports.get(name)
    if (imported?.marker) fail(node, 'SCAN_MARKER_USED_AS_VALUE')
    if (imported) return evaluate(imported.file.exported.get(imported.name), imported.file, depth + 1)
    const value = file.locals.get(name)
    if (!value) fail(node, 'SCAN_IDENTIFIER_UNRESOLVED')
    return evaluate(value, file, depth + 1)
  }
  const marker = (node, file) => {
    node = unwrap(node)
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return undefined
    return file.imports.get(node.expression.text)?.marker
  }
  const evaluate = (original, file, depth = 0) => {
    const node = unwrap(original)
    if (depth > 64) fail(node, 'SCAN_EXPRESSION_DEPTH_LIMIT')
    if (active.has(node)) fail(node, 'SCAN_CYCLIC_CONST')
    if (cache.has(node)) return cache.get(node)
    active.add(node)
    let value
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) value = node.text
    else if (ts.isNumericLiteral(node)) {
      value = Number(node.text)
      if (!Number.isSafeInteger(value)) fail(node, 'SCAN_SAFE_INTEGER_REQUIRED')
    } else if (node.kind === ts.SyntaxKind.TrueKeyword) value = true
    else if (node.kind === ts.SyntaxKind.FalseKeyword) value = false
    else if (node.kind === ts.SyntaxKind.NullKeyword) value = null
    else if (ts.isIdentifier(node)) value = reference(file, node.text, node, depth)
    else if (ts.isArrayLiteralExpression(node)) {
      value = []
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) {
          const spread = evaluate(element.expression, file, depth + 1)
          if (!Array.isArray(spread)) fail(element, 'SCAN_ARRAY_SPREAD_INVALID')
          value.push(...spread)
        } else value.push(evaluate(element, file, depth + 1))
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      value = Object.create(null)
      const set = (name, item, location) => {
        if (['__proto__', 'prototype', 'constructor'].includes(name) || Object.hasOwn(value, name)) fail(location, 'SCAN_OBJECT_KEY_INVALID_OR_DUPLICATE')
        value[name] = item
      }
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = evaluate(property.expression, file, depth + 1)
          if (!spread || typeof spread !== 'object' || Array.isArray(spread)) fail(property, 'SCAN_OBJECT_SPREAD_INVALID')
          for (const [name, item] of Object.entries(spread)) set(name, item, property)
        } else if (ts.isShorthandPropertyAssignment(property)) set(property.name.text, reference(file, property.name.text, property, depth), property)
        else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
          set(property.name.text, evaluate(property.initializer, file, depth + 1), property)
        } else fail(property, 'SCAN_STATIC_OBJECT_PROPERTY_REQUIRED')
      }
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const owner = evaluate(node.expression, file, depth + 1)
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : evaluate(node.argumentExpression, file, depth + 1)
      if (!owner || typeof owner !== 'object' || !Object.hasOwn(owner, key) || ['__proto__', 'prototype', 'constructor'].includes(String(key))) fail(node, 'SCAN_STATIC_MEMBER_UNRESOLVED')
      value = owner[key]
    } else if (ts.isCallExpression(node) && marker(node, file)) {
      if (node.arguments.length !== 1) fail(node, 'SCAN_MARKER_ARGUMENT_INVALID')
      value = evaluate(node.arguments[0], file, depth + 1)
      if (!Array.isArray(value)) fail(node, 'SCAN_MARKER_ARRAY_REQUIRED')
    } else fail(node, 'SCAN_DYNAMIC_EXPRESSION_FORBIDDEN')
    active.delete(node)
    cache.set(node, value)
    return value
  }
  const result = { permissionDefinitions: [], permissionReferences: [], resources: [], resourceReferences: [], messages: [] }
  const entryOwners = new Set()
  for (const id of moduleIds) {
    if (!config.modules[id] || Object.keys(config.modules[id]).some(key => key !== 'entryPoints')) throw new Error('SCAN_MODULE_CONFIG_INVALID')
    const entries = config.modules[id]?.entryPoints
    if (!Array.isArray(entries) || !entries.length || entries.length > 256) throw new Error('SCAN_MODULE_ENTRYPOINTS_REQUIRED:' + id)
    let declarations = 0
    for (const entry of entries) {
      if (typeof entry !== 'string') throw new Error('SCAN_ENTRYPOINT_INVALID')
      const path = await realpath(resolve(root, entry))
      if (entryOwners.has(path)) throw new Error('SCAN_ENTRYPOINT_HAS_MULTIPLE_OWNERS')
      entryOwners.add(path)
      const file = await load(path)
      for (const [name, initializer] of file.locals) {
        const value = evaluate(initializer, file)
        const declaration = marker(initializer, file)
        if (declaration) {
          if (!file.exported.has(name)) fail(initializer, 'SCAN_DECLARATION_MUST_BE_EXPORTED')
          result[MARKERS.get(declaration)].push(...value)
          declarations += 1
        }
      }
    }
    if (declarations === 0) throw new Error('SCAN_MODULE_HAS_NO_DECLARATION:' + id)
  }
  // Inspect imported const initializers too; an unused dynamic value must not be silently ignored.
  for (const file of files.values()) for (const initializer of file.locals.values()) evaluate(initializer, file)
  for (const [path, file] of files) if (sha256(await readFile(path)) !== file.digest) throw new Error('SCAN_SOURCE_CHANGED')
  const manifest = validate({ schemaVersion: '1.0', application: config.application,
    producer: { id: config.producerId, kind: 'REACT_TYPESCRIPT', snapshotMode: mode,
      ownedKeyPrefixes: config.ownedKeyPrefixes, expectedModules: config.expectedModules, scannedModules: moduleIds, clearIntent: config.clearIntent ?? false },
    artifact: config.artifact, ...result })
  const sourceFiles = [...files.entries()].map(([path, file]) => ({ path: relative(root, path).split('\\').join('/'), sha256: file.digest }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return { manifest, sourceFiles, sourceDigest: sha256(canonicalJson(sourceFiles)) }
}
