/** Type surface of the pinned RC Manifest 1.0 schema; the offline scanner validates its artifact. */
export type PermissionGroup = Readonly<{ mode: 'ALL' | 'ANY'; codes: readonly string[] }> | Readonly<{ access: 'PUBLIC' }>
export type PermissionRequirement = PermissionGroup | Readonly<{ allOf: readonly PermissionGroup[] }>
export interface I18nReference {
  readonly pageCode: string
  readonly labelKey: string
  readonly descriptionKey?: string | null
  readonly helpKey?: string | null
  readonly placeholderKey?: string | null
  readonly validationKey?: string | null
}
export interface PermissionDefinition {
  readonly code: string
  readonly meaning: string
  readonly i18n: I18nReference
  readonly lifecycle?: 'ACTIVE' | 'DEPRECATED' | null
}
export interface ResourceDefinition {
  readonly key: string
  readonly type: 'APP' | 'MENU' | 'PAGE' | 'COMPONENT' | 'BUTTON'
  readonly target: Readonly<Record<string, string | readonly string[]>>
  readonly access?: 'PROTECTED' | 'PUBLIC' | 'INTERNAL' | null
  readonly requirement?: PermissionRequirement | null
  readonly allowedPrincipals?: readonly ('USER' | 'SERVICE')[] | null
  readonly oauthScopes?: readonly string[] | null
  readonly i18n: I18nReference
  readonly lifecycle?: 'ACTIVE' | 'DEPRECATED' | null
}
export interface ResourceReference {
  readonly key: string
  readonly usage: 'FORM_FIELD' | 'TABLE_FIELD' | 'DETAIL_FIELD' | 'CALLS' | 'PARENT' | 'COMPONENT'
}
export interface SourceMessage {
  readonly pageCode: string
  readonly key: string
  readonly defaultLocale: string
  readonly defaults: Readonly<Record<string, string>>
}

/** These functions are type/static markers. The compiler tool parses their arguments without executing them. */
export const definePermissions = <const T extends readonly PermissionDefinition[]>(definitions: T): T => definitions
export const definePermissionReferences = <const T extends readonly string[]>(references: T): T => references
export const defineResources = <const T extends readonly ResourceDefinition[]>(resources: T): T => resources
export const defineResourceReferences = <const T extends readonly ResourceReference[]>(references: T): T => references
export const defineMessages = <const T extends readonly SourceMessage[]>(messages: T): T => messages
export type ResourceKey<T extends readonly ResourceDefinition[]> = T[number]['key']
