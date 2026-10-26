import { readFile, stat } from 'node:fs/promises'
import { canonicalJson, manifestDigests } from './canonicalize.mjs'
import { parseStrictJson } from './validate-manifest.mjs'

export class PermissionToolFailure extends Error {
  constructor(code, exitCode, details = {}) { super(code); this.name = 'PermissionToolFailure'; this.exitCode = exitCode; this.details = details }
}
const fail = (code, exitCode = 2, details) => { throw new PermissionToolFailure(code, exitCode, details) }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const decimal = (value, zero = true) => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value)
  && BigInt(value) <= 9_223_372_036_854_775_807n && (zero || value !== '0')
const identifier = (value, maximum = 128) => typeof value === 'string' && value.length <= maximum && /^[A-Za-z][A-Za-z0-9_.:/-]*$/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const fields = (value, names) => record(value) && Object.keys(value).every(key => names.includes(key))
const targetFields = ['catalogScopeId', 'tenantId', 'businessCode', 'applicationCode', 'namespaceCode', 'environment']
export const validateCatalogTarget = target => {
  if (!fields(target, targetFields) || Object.keys(target).length !== targetFields.length || !decimal(target.catalogScopeId, false)
    || !decimal(target.tenantId, false) || !['businessCode', 'applicationCode', 'namespaceCode', 'environment'].every(key => identifier(target[key]))) fail('CATALOG_TARGET_INVALID')
  return target
}
const sameTarget = (left, right) => canonicalJson(validateCatalogTarget(left)) === canonicalJson(validateCatalogTarget(right))
const httpsUri = value => {
  if (typeof value !== 'string' || value.length > 2048 || /[%\\\s]/.test(value)) return false
  try {const uri = new URL(value); return uri.protocol === 'https:' && !uri.username && !uri.password && !uri.search && !uri.hash
    && (uri.href === value || uri.href === value + '/')} catch {return false}
}
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+Z$/.test(value) && Number.isFinite(Date.parse(value))
const validDigests = value => fields(value, ['policyDigest', 'metadataDigest', 'manifestDigest']) && Object.keys(value).length === 3
  && Object.values(value).every(digest)

export const loadTargetProfile = async (file, name) => {
  let configuration
  try {configuration = parseStrictJson(await readFile(file))} catch {fail('TARGET_CONFIGURATION_INVALID')}
  if (!fields(configuration, ['schemaVersion', 'targets']) || configuration.schemaVersion !== 1 || !record(configuration.targets)
    || !Object.hasOwn(configuration.targets, name)) fail('TARGET_NOT_CONFIGURED')
  const profile = configuration.targets[name]
  if (!fields(profile, ['baseUrl', 'target', 'producerId', 'authentication']) || !httpsUri(profile.baseUrl)
    || new URL(profile.baseUrl).pathname !== '/' || !identifier(profile.producerId)) fail('TARGET_PROFILE_INVALID')
  validateCatalogTarget(profile.target)
  if (profile.target.environment !== name) fail('TARGET_ENVIRONMENT_MISMATCH')
  const auth = profile.authentication
  if (!fields(auth, ['issuer', 'clientId', 'resource', 'scopes', 'clientSecretFileEnv']) || !httpsUri(auth.issuer)
    || !/^\/(?:platform|tenants\/[1-9][0-9]{0,18})$/.test(new URL(auth.issuer).pathname)
    || typeof auth.clientId !== 'string' || !auth.clientId.length || auth.clientId.length > 256 || /[\r\n]/.test(auth.clientId)
    || !httpsUri(auth.resource) || !Array.isArray(auth.scopes) || auth.scopes.length < 1 || auth.scopes.length > 64
    || auth.scopes.some(value => typeof value !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(value))
    || new Set(auth.scopes).size !== auth.scopes.length || !/^[A-Z][A-Z0-9_]{0,127}$/.test(auth.clientSecretFileEnv)) fail('TARGET_AUTHENTICATION_CONFIGURATION_INVALID')
  return profile
}

export const validatePlan = (plan, profile, expected) => {
  if (!fields(plan, ['planId', 'target', 'producerId', 'expectedProducerRevision', 'expectedActiveRevision', 'digests', 'diff', 'expiresAt'])
    || !decimal(plan.planId, false) || !sameTarget(plan.target, profile.target) || plan.producerId !== profile.producerId
    || !decimal(plan.expectedProducerRevision) || !decimal(plan.expectedActiveRevision) || !validDigests(plan.digests)
    || !instant(plan.expiresAt) || Date.parse(plan.expiresAt) <= Date.now()
    || !fields(plan.diff, ['entries', 'authorizationExpansion', 'conflicts', 'absenceCompared']) || !Array.isArray(plan.diff.entries)
    || plan.diff.entries.length > 40_000 || !Array.isArray(plan.diff.conflicts) || plan.diff.conflicts.length > 40_000
    || plan.diff.conflicts.some(value => typeof value !== 'string' || value.length > 2048)
    || typeof plan.diff.authorizationExpansion !== 'boolean' || typeof plan.diff.absenceCompared !== 'boolean') fail('REGISTRATION_PLAN_INVALID')
  for (const entry of plan.diff.entries) {
    if (!fields(entry, ['kind', 'domain', 'key', 'reason', 'authorizationExpansion']) || !['kind', 'domain', 'key', 'reason'].every(key => typeof entry[key] === 'string' && entry[key].length <= 2048)
      || typeof entry.authorizationExpansion !== 'boolean') fail('REGISTRATION_PLAN_INVALID')
  }
  if (expected && (plan.expectedProducerRevision !== expected.expectedProducerRevision || plan.expectedActiveRevision !== expected.expectedActiveRevision
    || canonicalJson(plan.digests) !== canonicalJson(expected.digests))) fail('REGISTRATION_PLAN_BINDING_MISMATCH')
  return plan
}
export const registrationRequest = (plan, operationId, profile) => {
  validatePlan(plan, profile)
  if (!uuid(operationId)) fail('OPERATION_ID_INVALID')
  if (plan.diff.conflicts.length) fail('REGISTRATION_PLAN_CONFLICT', 3)
  return {target: plan.target, producerId: plan.producerId, planId: plan.planId, operationId,
    digests: plan.digests, expectedProducerRevision: plan.expectedProducerRevision, expectedActiveRevision: plan.expectedActiveRevision}
}
export const preparePlanRequest = (manifest, expectedProducerRevision, expectedActiveRevision, profile) => {
  if (!decimal(expectedProducerRevision) || !decimal(expectedActiveRevision) || manifest.producer.id !== profile.producerId
    || manifest.application.businessCode !== profile.target.businessCode || manifest.application.applicationCode !== profile.target.applicationCode) fail('MANIFEST_TARGET_BINDING_MISMATCH')
  return {target: profile.target, manifest, expectedProducerRevision, expectedActiveRevision}
}
export const validateActivation = (selection, profile) => {
  if (!fields(selection, ['target', 'operationId', 'expectedActiveRevision', 'producers']) || !sameTarget(selection.target, profile.target)
    || !uuid(selection.operationId) || !decimal(selection.expectedActiveRevision) || !Array.isArray(selection.producers)
    || selection.producers.length < 1 || selection.producers.length > 256 || new Set(selection.producers.map(value => value?.producerId)).size !== selection.producers.length) fail('ACTIVATION_SELECTION_INVALID')
  for (const member of selection.producers) if (!fields(member, ['producerId', 'producerVersion', 'qualificationId']) || !identifier(member.producerId)
    || !decimal(member.producerVersion, false) || !decimal(member.qualificationId, false)) fail('ACTIVATION_SELECTION_INVALID')
  return selection
}
const registrationResult = (value, profile, operationId, expected) => {
  const receipt = value?.receipt
  if (!fields(value, ['receipt', 'currentState', 'failureCode']) || !fields(receipt, ['operationId', 'planId', 'scope', 'producerId', 'producerVersion', 'digests', 'resourceIds', 'permissionIds', 'resourceCount', 'permissionCount', 'messageCount', 'registeredAt'])
    || receipt.operationId !== operationId || !sameTarget(receipt.scope, profile.target) || receipt.producerId !== profile.producerId
    || !decimal(receipt.planId, false) || !decimal(receipt.producerVersion, false) || !validDigests(receipt.digests)
    || !record(receipt.resourceIds) || !record(receipt.permissionIds) || !Object.values(receipt.resourceIds).every(value => decimal(value, false))
    || !Object.values(receipt.permissionIds).every(value => decimal(value, false)) || receipt.resourceCount !== Object.keys(receipt.resourceIds).length
    || receipt.permissionCount !== Object.keys(receipt.permissionIds).length || !Number.isSafeInteger(receipt.messageCount) || receipt.messageCount < 0
    || !instant(receipt.registeredAt) || !['METADATA_PENDING', 'READY', 'FAILED'].includes(value.currentState)
    || !(value.failureCode === null || typeof value.failureCode === 'string' && /^[A-Z0-9_]{1,128}$/.test(value.failureCode))) fail('REGISTRATION_RESPONSE_INVALID', 5, {operationId})
  if (expected && (receipt.planId !== expected.planId || canonicalJson(receipt.digests) !== canonicalJson(expected.digests))) fail('REGISTRATION_RESPONSE_BINDING_MISMATCH', 5, {operationId})
  return value
}
const activationResult = (value, profile, operationId, expected) => {
  if (!fields(value, ['scope', 'activationVersion', 'operationId', 'policyVersion', 'createdAt', 'producers']) || !sameTarget(value.scope, profile.target)
    || value.operationId !== operationId || !decimal(value.activationVersion, false) || !decimal(value.policyVersion) || !instant(value.createdAt)
    || !Array.isArray(value.producers) || value.producers.length < 1 || value.producers.length > 256) fail('ACTIVATION_RESPONSE_INVALID', 5, {operationId})
  for (const member of value.producers) if (!fields(member, ['producerId', 'producerVersion', 'sourceVersion', 'digests', 'qualificationId', 'artifactDigest'])
    || !identifier(member.producerId) || !decimal(member.producerVersion, false) || !decimal(member.qualificationId, false)
    || !digest(member.sourceVersion) || !validDigests(member.digests) || member.sourceVersion !== member.digests.manifestDigest
    || !digest(member.artifactDigest)) fail('ACTIVATION_RESPONSE_INVALID', 5, {operationId})
  if (new Set(value.producers.map(member => member.producerId)).size !== value.producers.length) fail('ACTIVATION_RESPONSE_INVALID', 5, {operationId})
  if (expected) {
    const members = list => [...list].map(({producerId, producerVersion, qualificationId}) => ({producerId, producerVersion, qualificationId})).sort((a, b) => a.producerId.localeCompare(b.producerId, 'en'))
    if (canonicalJson(members(value.producers)) !== canonicalJson(members(expected.producers))) fail('ACTIVATION_RESPONSE_BINDING_MISMATCH', 5, {operationId})
  }
  return value
}

const readResponse = async (response, maximum) => {
  const reader = response.body?.getReader()
  if (!reader) fail('TARGET_RESPONSE_INVALID', 5)
  const chunks = []; let length = 0
  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maximum) {await reader.cancel(); fail('TARGET_RESPONSE_TOO_LARGE', 5)}
    chunks.push(value)
  }
  try {return parseStrictJson(Buffer.concat(chunks.map(value => Buffer.from(value))))} catch {fail('TARGET_RESPONSE_INVALID', 5)}
}
const responseError = (status, operationId, write) => {
  if ([401, 403].includes(status)) fail('AUTHENTICATION_OR_AUTHORIZATION_DENIED', 4, {httpStatus: status, ...(operationId ? {operationId} : {})})
  if ([409, 412].includes(status)) fail('CATALOG_CAS_OR_OWNERSHIP_CONFLICT', 3, {httpStatus: status, ...(operationId ? {operationId} : {})})
  if (status === 404 && operationId) fail('OPERATION_NOT_FOUND', 6, {operationId})
  if (status >= 500 || status === 429) fail(write && operationId ? 'OPERATION_OUTCOME_UNKNOWN' : 'TARGET_UNAVAILABLE', write && operationId ? 6 : 5, {httpStatus: status, ...(operationId ? {operationId} : {})})
  fail('TARGET_INPUT_REJECTED', 2, {httpStatus: status})
}

/** Fixed target and CC identity; mutations are dispatched at most once per explicit invocation. */
export const createRegistrationClient = (profile, {fetcher = globalThis.fetch, environment = process.env, timeoutMs = 15_000} = {}) => {
  if (!httpsUri(profile?.baseUrl) || !httpsUri(profile.authentication?.issuer) || !httpsUri(profile.authentication?.resource)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('REGISTRATION_CLIENT_CONFIGURATION_INVALID')
  let token = null
  const accessToken = async () => {
    if (token && token.expiresAt > Date.now() + 5_000) return token.value
    const file = environment[profile.authentication.clientSecretFileEnv]
    if (!file) fail('CLIENT_SECRET_FILE_REQUIRED', 4)
    let secret
    try {
      const info = await stat(file)
      if (!info.isFile() || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || info.size < 1 || info.size > 8192) fail('CLIENT_SECRET_FILE_PERMISSIONS_INVALID', 4)
      secret = (await readFile(file, 'utf8')).replace(/\r?\n$/, '')
      if (!secret || /[\r\n\0]/.test(secret)) fail('CLIENT_SECRET_FILE_INVALID', 4)
    } catch (error) {if (error instanceof PermissionToolFailure) throw error; fail('CLIENT_SECRET_FILE_UNAVAILABLE', 4)}
    const form = new URLSearchParams({grant_type: 'client_credentials', resource: profile.authentication.resource, scope: profile.authentication.scopes.join(' ')})
    const encode = value => new URLSearchParams({v: value}).toString().slice(2)
    let response
    try {
      response = await fetcher(profile.authentication.issuer + '/oauth2/token', {method: 'POST', redirect: 'error',
        headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
          Authorization: 'Basic ' + Buffer.from(encode(profile.authentication.clientId) + ':' + encode(secret)).toString('base64')},
        body: form.toString(), signal: AbortSignal.timeout(timeoutMs)})
      secret = undefined
    } catch {secret = undefined; fail('IDENTITY_TOKEN_SERVICE_UNAVAILABLE', 5)}
    if (!response.ok) {
      // Cleanup failure must not hide the authenticated endpoint's actual HTTP status.
      await response.body?.cancel().catch(() => undefined)
      if ([400, 401, 403].includes(response.status)) fail('CLIENT_CREDENTIALS_REJECTED', 4)
      responseError(response.status)
    }
    let result
    try {result = await readResponse(response, 64 * 1024)} catch (error) {
      if (error instanceof PermissionToolFailure) throw error
      fail('IDENTITY_TOKEN_SERVICE_UNAVAILABLE', 5)
    }
    if (typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer' || typeof result.access_token !== 'string' || !/^[A-Za-z0-9._~+/-]{1,16384}={0,2}$/.test(result.access_token)
      || !Number.isSafeInteger(result.expires_in) || result.expires_in < 1 || result.expires_in > 86400) fail('IDENTITY_TOKEN_RESPONSE_INVALID', 4)
    token = {value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000}
    return token.value
  }
  const request = async (path, method = 'GET', body, operationId) => {
    const bearer = await accessToken()
    let response
    try {
      response = await fetcher(profile.baseUrl.replace(/\/$/, '') + path, {method, redirect: 'error', cache: 'no-store',
        headers: {Accept: 'application/json', Authorization: 'Bearer ' + bearer, ...(body ? {'Content-Type': 'application/json'} : {})},
        ...(body ? {body: canonicalJson(body)} : {}), signal: AbortSignal.timeout(timeoutMs)})
    } catch {fail(method === 'POST' && operationId ? 'OPERATION_OUTCOME_UNKNOWN' : 'TARGET_UNAVAILABLE', method === 'POST' && operationId ? 6 : 5, operationId ? {operationId} : {})}
    if (!response.ok) {await response.body?.cancel().catch(() => undefined); responseError(response.status, operationId, method === 'POST')}
    try {
      const envelope = await readResponse(response, 16 * 1024 * 1024)
      if (!record(envelope) || envelope.success !== true || envelope.code !== 10000 || envelope.data === null || envelope.data === undefined) fail('TARGET_ENVELOPE_INVALID', 5)
      return envelope.data
    } catch (error) {
      if (method === 'POST' && operationId) fail('OPERATION_OUTCOME_UNKNOWN', 6, {operationId})
      if (error instanceof PermissionToolFailure) throw error
      fail('TARGET_RESPONSE_UNAVAILABLE', 5, operationId ? {operationId} : {})
    }
  }
  const query = operationId => new URLSearchParams({...profile.target, producerId: profile.producerId, ...(operationId ? {operationId} : {})}).toString()
  return {
    plan: async (manifest, expectedProducerRevision, expectedActiveRevision) => {
      const body = preparePlanRequest(manifest, expectedProducerRevision, expectedActiveRevision, profile)
      const {canonical: _canonical, ...digests} = manifestDigests(manifest)
      return validatePlan(await request('/api/v1/permission-manifests/plans', 'POST', body), profile, {...body, digests})
    },
    register: async (plan, operationId) => {
      const body = registrationRequest(plan, operationId, profile)
      const result = await request('/api/v1/permission-manifests/registrations', 'POST', body, operationId)
      try {return registrationResult(result, profile, operationId, body)} catch {fail('OPERATION_OUTCOME_UNKNOWN', 6, {operationId})}
    },
    status: async (operationId, kind = 'registration') => {
      if (!uuid(operationId) || !['registration', 'activation'].includes(kind)) fail('STATUS_INPUT_INVALID')
      return kind === 'registration'
        ? registrationResult(await request('/api/v1/permission-manifests/registrations/' + operationId + '?' + query(), 'GET', undefined, operationId), profile, operationId)
        : activationResult(await request('/api/v1/permission-catalogs/versions?' + query(operationId), 'GET', undefined, operationId), profile, operationId)
    },
    activate: async selection => {
      validateActivation(selection, profile)
      const result = await request('/api/v1/permission-catalogs/activations', 'POST', selection, selection.operationId)
      try {return activationResult(result, profile, selection.operationId, selection)} catch {fail('OPERATION_OUTCOME_UNKNOWN', 6, {operationId: selection.operationId})}
    },
  }
}

export const waitForOperation = async (client, operationId, kind, {seconds = 0, now = () => performance.now(),
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), onResult = async () => undefined} = {}) => {
  if (!uuid(operationId) || !['registration', 'activation'].includes(kind) || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 3600) fail('STATUS_INPUT_INVALID')
  const deadline = now() + seconds * 1000
  for (;;) {
    let result
    try {result = await client.status(operationId, kind)} catch (error) {
      if (!(error instanceof PermissionToolFailure) || error.message !== 'OPERATION_NOT_FOUND') throw error
    }
    if (result) {
      await onResult(result)
      if (kind === 'activation' || result.currentState === 'READY') return {status: kind === 'activation' ? 'ACTIVATED' : 'READY', operationId}
      if (result.currentState === 'FAILED') fail('REGISTRATION_FAILED', 5, {operationId, currentState: 'FAILED', preserveOutput: true})
    }
    if (now() >= deadline) fail('OPERATION_STILL_PENDING', 6, {operationId, currentState: result?.currentState ?? 'UNKNOWN', preserveOutput: Boolean(result)})
    await sleep(Math.min(1000, deadline - now()))
  }
}
